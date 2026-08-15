using System;
using System.Text.Json;

namespace RevitBridge.Operator
{
    internal enum OperatorApprovalMode
    {
        Safe = 0,
        AllowWritesThisSession = 1,
        Yolo = 2
    }

    internal enum OperatorActionRisk
    {
        Low = 0,
        Medium = 1,
        High = 2
    }

    internal enum OperatorActionEffect
    {
        Read = 0,
        Preview = 1,
        Apply = 2
    }

    internal sealed class OperatorNativeApiRuntimePolicyState
    {
        internal string Profile { get; set; } = "broad";
        internal OperatorActionRisk MaxRisk { get; set; } = OperatorActionRisk.High;
        internal bool AllowMutating { get; set; } = true;
        internal bool BlockFreezeRisk { get; set; } = true;
        internal bool Locked { get; set; }
        internal string LockReason { get; set; } = "";
        internal string Source { get; set; } = "env/default";
    }

    internal static class OperatorNativeApiRuntimeSafety
    {
        internal const string HostedPolicyLockReason =
            "Native API policy is locked to the balanced non-mutating profile in hosted runtime mode; runtime policy changes are rejected.";

        internal const string ProductionPolicyLockReason =
            "Native API policy is locked to the balanced non-mutating profile in production runtime mode; runtime policy changes are rejected.";

        internal const string HostedFlagPolicyLockReason =
            "Native API policy is locked to the balanced non-mutating profile because hosted runtime is explicitly enabled; runtime policy changes are rejected.";

        internal const string UnsupportedRuntimeModePolicyLockReason =
            "Native API policy is locked to the balanced non-mutating profile because REVIT_OPERATOR_MODE is unsupported; runtime policy changes are rejected.";

        internal const string InvalidHostedFlagPolicyLockReason =
            "Native API policy is locked to the balanced non-mutating profile because OPERATOR_HOSTED_ENABLED is invalid; runtime policy changes are rejected.";

        internal static string NormalizeRuntimeMode(string? rawMode)
        {
            var mode = (rawMode ?? "").Trim().ToLowerInvariant();
            return string.IsNullOrWhiteSpace(mode) ? "local" : mode;
        }

        internal static bool RequiresLockedNonMutatingPolicy(string? rawMode)
        {
            var mode = NormalizeRuntimeMode(rawMode);
            return !IsSupportedRuntimeMode(mode) || mode == "hosted" || mode == "production";
        }

        internal static string GetPolicyLockReason(string? rawMode)
        {
            var mode = NormalizeRuntimeMode(rawMode);
            if (mode == "hosted") return HostedPolicyLockReason;
            if (mode == "production") return ProductionPolicyLockReason;
            if (!IsSupportedRuntimeMode(mode)) return UnsupportedRuntimeModePolicyLockReason;
            return "";
        }

        internal static bool TryParseBoolean(string? raw, out bool value)
        {
            var configured = (raw ?? "").Trim().ToLowerInvariant();
            if (configured == "1" || configured == "true" || configured == "yes" || configured == "on")
            {
                value = true;
                return true;
            }
            if (configured == "0" || configured == "false" || configured == "no" || configured == "off")
            {
                value = false;
                return true;
            }

            value = false;
            return false;
        }

        internal static OperatorNativeApiRuntimePolicyState ApplyAfterConfiguredOverrides(
            string? rawMode,
            OperatorNativeApiRuntimePolicyState configured)
        {
            return ApplyAfterConfiguredOverrides(rawMode, null, configured);
        }

        internal static OperatorNativeApiRuntimePolicyState ApplyAfterConfiguredOverrides(
            string? rawMode,
            string? rawHostedEnabled,
            OperatorNativeApiRuntimePolicyState configured)
        {
            if (configured == null) throw new ArgumentNullException(nameof(configured));

            var mode = NormalizeRuntimeMode(rawMode);
            string reason;
            string source;
            if (!IsSupportedRuntimeMode(mode))
            {
                reason = UnsupportedRuntimeModePolicyLockReason;
                source = "runtime-mode:unsupported";
            }
            else if (!string.IsNullOrWhiteSpace(rawHostedEnabled) &&
                     !TryParseBoolean(rawHostedEnabled, out _))
            {
                reason = InvalidHostedFlagPolicyLockReason;
                source = "hosted-flag:invalid";
            }
            else if (mode == "hosted")
            {
                reason = HostedPolicyLockReason;
                source = "runtime-mode:hosted";
            }
            else if (mode == "production")
            {
                reason = ProductionPolicyLockReason;
                source = "runtime-mode:production";
            }
            else if (TryParseBoolean(rawHostedEnabled, out var hostedEnabled) && hostedEnabled)
            {
                reason = HostedFlagPolicyLockReason;
                source = "hosted-flag:true";
            }
            else
            {
                return configured;
            }

            return new OperatorNativeApiRuntimePolicyState
            {
                Profile = "balanced",
                MaxRisk = OperatorActionRisk.Medium,
                AllowMutating = false,
                BlockFreezeRisk = true,
                Locked = true,
                LockReason = reason,
                Source = source
            };
        }

        private static bool IsSupportedRuntimeMode(string mode)
        {
            return mode == "local" ||
                   mode == "development" ||
                   mode == "self_hosted" ||
                   mode == "hosted" ||
                   mode == "production";
        }
    }

    internal static class OperatorApprovalPolicy
    {
        public static OperatorActionRisk GetRisk(string method, string path)
        {
            var m = (method ?? "").Trim().ToUpperInvariant();
            var p = (path ?? "").Trim();

            if (m == "GET") return OperatorActionRisk.Low;

            if (m == "POST")
            {
                if (string.Equals(p, "/ui/open", StringComparison.OrdinalIgnoreCase)) return OperatorActionRisk.Low;
                if (string.Equals(p, "/ui/close", StringComparison.OrdinalIgnoreCase)) return OperatorActionRisk.Low;
                if (string.Equals(p, "/revit/batch-job", StringComparison.OrdinalIgnoreCase)) return OperatorActionRisk.Medium;
                if (string.Equals(p, "/revit/batch-control", StringComparison.OrdinalIgnoreCase)) return OperatorActionRisk.Low;

                // Exports are file outputs, but not model edits.
                if (string.Equals(p, "/revit/export-image", StringComparison.OrdinalIgnoreCase)) return OperatorActionRisk.Low;
                if (string.Equals(p, "/revit/capture-screenshare", StringComparison.OrdinalIgnoreCase)) return OperatorActionRisk.Low;
                if (string.Equals(p, "/revit/export-view-frame", StringComparison.OrdinalIgnoreCase)) return OperatorActionRisk.Low;
                if (string.Equals(p, "/revit/export-view-region", StringComparison.OrdinalIgnoreCase)) return OperatorActionRisk.Low;
                if (string.Equals(p, "/revit/export-visible-elements", StringComparison.OrdinalIgnoreCase)) return OperatorActionRisk.Low;
                if (string.Equals(p, "/revit/highlight-and-export", StringComparison.OrdinalIgnoreCase)) return OperatorActionRisk.Low;
                if (string.Equals(p, "/revit/export-pdf", StringComparison.OrdinalIgnoreCase)) return OperatorActionRisk.Low;
                if (string.Equals(p, "/revit/print", StringComparison.OrdinalIgnoreCase)) return OperatorActionRisk.High;
                if (string.Equals(p, "/revit/export-images", StringComparison.OrdinalIgnoreCase)) return OperatorActionRisk.Low;
                if (string.Equals(p, "/revit/export-dwg", StringComparison.OrdinalIgnoreCase)) return OperatorActionRisk.Low;
                if (string.Equals(p, "/revit/export-ifc", StringComparison.OrdinalIgnoreCase)) return OperatorActionRisk.Low;
                if (string.Equals(p, "/revit/export-elements-xlsx", StringComparison.OrdinalIgnoreCase)) return OperatorActionRisk.Low;
                if (string.Equals(p, "/revit/export-dimensioning-v2", StringComparison.OrdinalIgnoreCase)) return OperatorActionRisk.Medium;

                // Read-only helpers.
                if (string.Equals(p, "/revit/rooms", StringComparison.OrdinalIgnoreCase)) return OperatorActionRisk.Low;
                // POST is used for filter payload complexity; this endpoint only reads linked documents and boundary curves.
                if (string.Equals(p, "/revit/linked-room-boundaries", StringComparison.OrdinalIgnoreCase)) return OperatorActionRisk.Low;
                if (string.Equals(p, "/revit/renumber-rooms", StringComparison.OrdinalIgnoreCase)) return OperatorActionRisk.High;
                if (string.Equals(p, "/revit/room-contents", StringComparison.OrdinalIgnoreCase)) return OperatorActionRisk.Low;
                if (string.Equals(p, "/revit/spatial-context", StringComparison.OrdinalIgnoreCase)) return OperatorActionRisk.Low;
                if (string.Equals(p, "/revit/find-elements", StringComparison.OrdinalIgnoreCase)) return OperatorActionRisk.Low;
                if (string.Equals(p, "/revit/update-parameter-by-query", StringComparison.OrdinalIgnoreCase)) return OperatorActionRisk.High;
                if (string.Equals(p, "/revit/update-panel-parameter", StringComparison.OrdinalIgnoreCase)) return OperatorActionRisk.High;
                if (string.Equals(p, "/revit/locate-elements", StringComparison.OrdinalIgnoreCase)) return OperatorActionRisk.Low;
                if (string.Equals(p, "/revit/get-placement-context", StringComparison.OrdinalIgnoreCase)) return OperatorActionRisk.Low;
                if (string.Equals(p, "/revit/resolve-room-wall", StringComparison.OrdinalIgnoreCase)) return OperatorActionRisk.Low;
                if (string.Equals(p, "/revit/rank-similar-devices-on-wall", StringComparison.OrdinalIgnoreCase)) return OperatorActionRisk.Low;
                if (string.Equals(p, "/revit/pick-candidate-cluster", StringComparison.OrdinalIgnoreCase)) return OperatorActionRisk.Low;
                if (string.Equals(p, "/revit/project-point-to-host-frame", StringComparison.OrdinalIgnoreCase)) return OperatorActionRisk.Low;
                if (string.Equals(p, "/revit/audit-hosted-instance-placement", StringComparison.OrdinalIgnoreCase)) return OperatorActionRisk.Low;
                if (string.Equals(p, "/revit/resolve-redline-target", StringComparison.OrdinalIgnoreCase)) return OperatorActionRisk.Low;
                if (string.Equals(p, "/revit/propose-fix", StringComparison.OrdinalIgnoreCase)) return OperatorActionRisk.Low;
                if (string.Equals(p, "/revit/find-duplicate-marks", StringComparison.OrdinalIgnoreCase)) return OperatorActionRisk.Low;
                if (string.Equals(p, "/revit/airflow-qa", StringComparison.OrdinalIgnoreCase)) return OperatorActionRisk.High;
                if (string.Equals(p, "/revit/mep-workflows", StringComparison.OrdinalIgnoreCase)) return OperatorActionRisk.High;
                if (string.Equals(p, "/revit/resolve-mep-routing-context", StringComparison.OrdinalIgnoreCase)) return OperatorActionRisk.Low;
                if (string.Equals(p, "/revit/create-mep-route", StringComparison.OrdinalIgnoreCase)) return OperatorActionRisk.High;
                if (string.Equals(p, "/revit/connect-mep-branch", StringComparison.OrdinalIgnoreCase)) return OperatorActionRisk.High;
                if (string.Equals(p, "/revit/connect-existing-mep-branch", StringComparison.OrdinalIgnoreCase)) return OperatorActionRisk.High;
                if (string.Equals(p, "/revit/connect-mep-elements", StringComparison.OrdinalIgnoreCase)) return OperatorActionRisk.High;
                if (string.Equals(p, "/revit/create-pipe-between-connectors", StringComparison.OrdinalIgnoreCase)) return OperatorActionRisk.High;
                if (string.Equals(p, "/revit/existing-conditions-mep-draft-workflow", StringComparison.OrdinalIgnoreCase)) return OperatorActionRisk.High;
                if (string.Equals(p, "/revit/copy-mep-pattern", StringComparison.OrdinalIgnoreCase)) return OperatorActionRisk.High;
                if (string.Equals(p, "/revit/mep-route-workflow", StringComparison.OrdinalIgnoreCase)) return OperatorActionRisk.High;
                if (string.Equals(p, "/revit/mep-branch-network-workflow", StringComparison.OrdinalIgnoreCase)) return OperatorActionRisk.High;
                if (string.Equals(p, "/revit/edit-mep-route-elements", StringComparison.OrdinalIgnoreCase)) return OperatorActionRisk.High;
                if (string.Equals(p, "/revit/reroute-mep-route-segment", StringComparison.OrdinalIgnoreCase)) return OperatorActionRisk.High;
                if (string.Equals(p, "/revit/arch-workflows", StringComparison.OrdinalIgnoreCase)) return OperatorActionRisk.High;
                if (string.Equals(p, "/revit/trace-connected-network", StringComparison.OrdinalIgnoreCase)) return OperatorActionRisk.Low;
                if (string.Equals(p, "/revit/room_mep_intersect", StringComparison.OrdinalIgnoreCase)) return OperatorActionRisk.Low;
                if (string.Equals(p, "/revit/ducts-by-spatial-scope", StringComparison.OrdinalIgnoreCase)) return OperatorActionRisk.Low;
                if (string.Equals(p, "/revit/find-elements-by-parameter", StringComparison.OrdinalIgnoreCase)) return OperatorActionRisk.Low;
                if (string.Equals(p, "/revit/sync-connected-sizes", StringComparison.OrdinalIgnoreCase)) return OperatorActionRisk.High;
                if (string.Equals(p, "/revit/resize-duct-run", StringComparison.OrdinalIgnoreCase)) return OperatorActionRisk.High;
                if (string.Equals(p, "/revit/resize-ducts-by-scope", StringComparison.OrdinalIgnoreCase)) return OperatorActionRisk.High;
                if (string.Equals(p, "/revit/resize-ducts-in-room", StringComparison.OrdinalIgnoreCase)) return OperatorActionRisk.High;
                if (string.Equals(p, "/revit/resize-ductwork-by-scope", StringComparison.OrdinalIgnoreCase)) return OperatorActionRisk.High;
                if (string.Equals(p, "/revit/repair-duct-continuity-by-scope", StringComparison.OrdinalIgnoreCase)) return OperatorActionRisk.High;
                if (string.Equals(p, "/revit/repair-mep-connectors", StringComparison.OrdinalIgnoreCase)) return OperatorActionRisk.High;
                if (string.Equals(p, "/revit/get-connectors", StringComparison.OrdinalIgnoreCase)) return OperatorActionRisk.Low;
                if (string.Equals(p, "/revit/pick-at-pixel", StringComparison.OrdinalIgnoreCase)) return OperatorActionRisk.Low;
                if (string.Equals(p, "/revit/activate-view", StringComparison.OrdinalIgnoreCase)) return OperatorActionRisk.Low;
                if (string.Equals(p, "/revit/query", StringComparison.OrdinalIgnoreCase)) return OperatorActionRisk.Low;
                if (string.Equals(p, "/revit/dynamic-runtime/bootstrap", StringComparison.OrdinalIgnoreCase)) return OperatorActionRisk.Low;
                if (string.Equals(p, "/revit/dynamic-runtime/register", StringComparison.OrdinalIgnoreCase)) return OperatorActionRisk.Low;
                if (string.Equals(p, "/revit/dynamic-runtime/snapshot", StringComparison.OrdinalIgnoreCase)) return OperatorActionRisk.Low;
                // Preview is transactionally rolled back and authorization only seals current trusted state.
                // Preserve a one-use grant for the sole mutating boundary below.
                if (string.Equals(p, "/revit/dynamic-runtime/preview", StringComparison.OrdinalIgnoreCase)) return OperatorActionRisk.Low;
                if (string.Equals(p, "/revit/dynamic-runtime/authorize-apply", StringComparison.OrdinalIgnoreCase)) return OperatorActionRisk.Low;
                if (string.Equals(p, "/revit/dynamic-runtime/apply", StringComparison.OrdinalIgnoreCase)) return OperatorActionRisk.High;
                if (string.Equals(p, "/revit/dynamic-runtime/observe-v1", StringComparison.OrdinalIgnoreCase)) return OperatorActionRisk.Low;
                if (string.Equals(p, "/revit/dynamic-runtime/observe-building-systems-v1", StringComparison.OrdinalIgnoreCase)) return OperatorActionRisk.Low;
                if (string.Equals(p, "/revit/dynamic-runtime/result-reference-facts-v1", StringComparison.OrdinalIgnoreCase)) return OperatorActionRisk.Low;
                if (string.Equals(p, "/revit/dynamic-runtime/mep-result-preview-v1", StringComparison.OrdinalIgnoreCase)) return OperatorActionRisk.Low;
                if (string.Equals(p, "/revit/dynamic-runtime/mep-result-authorize-v1", StringComparison.OrdinalIgnoreCase)) return OperatorActionRisk.Low;
                if (string.Equals(p, "/revit/dynamic-runtime/mep-result-apply-v1", StringComparison.OrdinalIgnoreCase)) return OperatorActionRisk.High;
                if (string.Equals(p, "/revit/dynamic-runtime/annotation-result-preview-v1", StringComparison.OrdinalIgnoreCase)) return OperatorActionRisk.Low;
                if (string.Equals(p, "/revit/dynamic-runtime/annotation-result-authorize-v1", StringComparison.OrdinalIgnoreCase)) return OperatorActionRisk.Low;
                if (string.Equals(p, "/revit/dynamic-runtime/annotation-result-apply-v1", StringComparison.OrdinalIgnoreCase)) return OperatorActionRisk.High;
                if (string.Equals(p, "/revit/dynamic-runtime/core-preview-v1", StringComparison.OrdinalIgnoreCase)) return OperatorActionRisk.Low;
                if (string.Equals(p, "/revit/dynamic-runtime/core-authorize-v1", StringComparison.OrdinalIgnoreCase)) return OperatorActionRisk.Low;
                if (string.Equals(p, "/revit/dynamic-runtime/core-apply-v1", StringComparison.OrdinalIgnoreCase)) return OperatorActionRisk.High;
                if (string.Equals(p, "/revit/resolve", StringComparison.OrdinalIgnoreCase)) return OperatorActionRisk.Low;
                if (string.Equals(p, "/revit/views", StringComparison.OrdinalIgnoreCase)) return OperatorActionRisk.Low;
                if (string.Equals(p, "/revit/sheets", StringComparison.OrdinalIgnoreCase)) return OperatorActionRisk.Low;
                if (string.Equals(p, "/revit/schedules", StringComparison.OrdinalIgnoreCase)) return OperatorActionRisk.Low;
                if (string.Equals(p, "/revit/export-schedule-csv", StringComparison.OrdinalIgnoreCase)) return OperatorActionRisk.Low;
                if (string.Equals(p, "/revit/export-warnings-report", StringComparison.OrdinalIgnoreCase)) return OperatorActionRisk.Low;
                if (string.Equals(p, "/revit/warnings", StringComparison.OrdinalIgnoreCase)) return OperatorActionRisk.Low;
                if (string.Equals(p, "/revit/get-titleblock-info", StringComparison.OrdinalIgnoreCase)) return OperatorActionRisk.Low;
                if (string.Equals(p, "/revit/print-sets", StringComparison.OrdinalIgnoreCase)) return OperatorActionRisk.Low;
                if (string.Equals(p, "/revit/revisions", StringComparison.OrdinalIgnoreCase)) return OperatorActionRisk.Low;
                if (string.Equals(p, "/revit/titleblock-label-map", StringComparison.OrdinalIgnoreCase)) return OperatorActionRisk.Low;
                if (string.Equals(p, "/revit/capture-sheet-region", StringComparison.OrdinalIgnoreCase)) return OperatorActionRisk.Low;
                if (string.Equals(p, "/revit/verify-parameter-on-sheet", StringComparison.OrdinalIgnoreCase)) return OperatorActionRisk.Low;
                if (string.Equals(p, "/revit/titleblock-family-update-text", StringComparison.OrdinalIgnoreCase)) return OperatorActionRisk.High;
                if (string.Equals(p, "/revit/titleblock-date-candidates", StringComparison.OrdinalIgnoreCase)) return OperatorActionRisk.Low;
                if (string.Equals(p, "/revit/titleblock-set-date-smart", StringComparison.OrdinalIgnoreCase)) return OperatorActionRisk.High;
                if (string.Equals(p, "/revit/get-family-file-path", StringComparison.OrdinalIgnoreCase)) return OperatorActionRisk.Low;
                if (string.Equals(p, "/revit/open-family-doc", StringComparison.OrdinalIgnoreCase)) return OperatorActionRisk.High;
                if (string.Equals(p, "/revit/find-text-notes", StringComparison.OrdinalIgnoreCase)) return OperatorActionRisk.Low;
                if (string.Equals(p, "/revit/replace-text-note", StringComparison.OrdinalIgnoreCase)) return OperatorActionRisk.High;
                if (string.Equals(p, "/revit/save-family-doc", StringComparison.OrdinalIgnoreCase)) return OperatorActionRisk.High;
                if (string.Equals(p, "/revit/load-family-doc", StringComparison.OrdinalIgnoreCase)) return OperatorActionRisk.High;
                if (string.Equals(p, "/revit/close-doc", StringComparison.OrdinalIgnoreCase)) return OperatorActionRisk.High;
                if (string.Equals(p, "/revit/edit-family-from-instance", StringComparison.OrdinalIgnoreCase)) return OperatorActionRisk.High;
                if (string.Equals(p, "/revit/find-family-text-notes", StringComparison.OrdinalIgnoreCase)) return OperatorActionRisk.Low;
                if (string.Equals(p, "/revit/set-text-note-text", StringComparison.OrdinalIgnoreCase)) return OperatorActionRisk.High;
                if (string.Equals(p, "/revit/reload-family-edit-session", StringComparison.OrdinalIgnoreCase)) return OperatorActionRisk.High;
                if (string.Equals(p, "/revit/get-element-summary", StringComparison.OrdinalIgnoreCase)) return OperatorActionRisk.Low;
                if (string.Equals(p, "/revit/get-parameters", StringComparison.OrdinalIgnoreCase)) return OperatorActionRisk.Low;
                if (string.Equals(p, "/revit/quantify", StringComparison.OrdinalIgnoreCase)) return OperatorActionRisk.Low;
                if (string.Equals(p, "/revit/quantify-visualize", StringComparison.OrdinalIgnoreCase)) return OperatorActionRisk.Medium;
                if (string.Equals(p, "/revit/measure-gap", StringComparison.OrdinalIgnoreCase)) return OperatorActionRisk.Low;
                if (string.Equals(p, "/revit/model-health", StringComparison.OrdinalIgnoreCase)) return OperatorActionRisk.Low;
                if (string.Equals(p, "/revit/qa-checks", StringComparison.OrdinalIgnoreCase)) return OperatorActionRisk.Low;
                if (string.Equals(p, "/revit/get-lighting-data", StringComparison.OrdinalIgnoreCase)) return OperatorActionRisk.Low;
                if (string.Equals(p, "/revit/analyze-dimensions", StringComparison.OrdinalIgnoreCase)) return OperatorActionRisk.Low;
                if (string.Equals(p, "/revit/spatial-analysis", StringComparison.OrdinalIgnoreCase)) return OperatorActionRisk.Low;
                if (string.Equals(p, "/revit/fire-damper-audit", StringComparison.OrdinalIgnoreCase)) return OperatorActionRisk.Low;
                if (string.Equals(p, "/revit/lighting-audit", StringComparison.OrdinalIgnoreCase)) return OperatorActionRisk.Low;
                if (string.Equals(p, "/revit/query-zone-data", StringComparison.OrdinalIgnoreCase)) return OperatorActionRisk.Low;
                if (string.Equals(p, "/revit/list-element-types", StringComparison.OrdinalIgnoreCase)) return OperatorActionRisk.Low;
                if (string.Equals(p, "/revit/resolve-element-type", StringComparison.OrdinalIgnoreCase)) return OperatorActionRisk.Low;
                if (string.Equals(p, "/revit/duplicate-element-type", StringComparison.OrdinalIgnoreCase)) return OperatorActionRisk.High;
                if (string.Equals(p, "/revit/set-type-parameters", StringComparison.OrdinalIgnoreCase)) return OperatorActionRisk.High;
                if (string.Equals(p, "/revit/duplicate-type-and-swap-instance", StringComparison.OrdinalIgnoreCase)) return OperatorActionRisk.High;
                if (string.Equals(p, "/revit/plan-family-evolution", StringComparison.OrdinalIgnoreCase)) return OperatorActionRisk.Low;
                if (string.Equals(p, "/revit/apply-family-evolution", StringComparison.OrdinalIgnoreCase)) return OperatorActionRisk.High;
                if (string.Equals(p, "/revit/read-family-evolution", StringComparison.OrdinalIgnoreCase)) return OperatorActionRisk.Low;
                if (string.Equals(p, "/revit/set-selection", StringComparison.OrdinalIgnoreCase)) return OperatorActionRisk.Low;
                if (string.Equals(p, "/revit/resolve-room-plan-view", StringComparison.OrdinalIgnoreCase)) return OperatorActionRisk.Low;
                if (string.Equals(p, "/revit/plan-dwelling-receptacles", StringComparison.OrdinalIgnoreCase)) return OperatorActionRisk.Low;
                if (string.Equals(p, "/revit/audit-electrical-circuit-loading", StringComparison.OrdinalIgnoreCase)) return OperatorActionRisk.Low;
                if (string.Equals(p, "/revit/audit-plumbing-fixture-services", StringComparison.OrdinalIgnoreCase)) return OperatorActionRisk.Low;
                if (string.Equals(p, "/revit/plan-room-receptacles-from-analog", StringComparison.OrdinalIgnoreCase)) return OperatorActionRisk.Low;
                if (string.Equals(p, "/revit/apply-room-receptacles-from-analog", StringComparison.OrdinalIgnoreCase)) return OperatorActionRisk.High;
                if (string.Equals(p, "/revit/tool-search", StringComparison.OrdinalIgnoreCase)) return OperatorActionRisk.Low;
                if (string.Equals(p, "/revit/tool-doc", StringComparison.OrdinalIgnoreCase)) return OperatorActionRisk.Low;
                if (string.Equals(p, "/revit/tool-examples", StringComparison.OrdinalIgnoreCase)) return OperatorActionRisk.Low;
                if (string.Equals(p, "/revit/native-api-catalog", StringComparison.OrdinalIgnoreCase)) return OperatorActionRisk.Low;
                if (string.Equals(p, "/revit/native-api-search", StringComparison.OrdinalIgnoreCase)) return OperatorActionRisk.Low;
                if (string.Equals(p, "/revit/native-api-ops", StringComparison.OrdinalIgnoreCase)) return OperatorActionRisk.Low;
                if (string.Equals(p, "/revit/native-api-mutation-ops", StringComparison.OrdinalIgnoreCase)) return OperatorActionRisk.High;
                // Policy mutation can widen the reflected native Revit API surface. It must
                // never inherit the approval-free behavior of ordinary medium-risk actions.
                if (string.Equals(p, "/revit/native-api-policy", StringComparison.OrdinalIgnoreCase)) return OperatorActionRisk.High;
                if (string.Equals(p, "/revit/native-api-call", StringComparison.OrdinalIgnoreCase)) return OperatorActionRisk.Medium;
                if (string.Equals(p, "/revit/self-test", StringComparison.OrdinalIgnoreCase)) return OperatorActionRisk.Low;
                if (string.Equals(p, "/revit/state-snapshot", StringComparison.OrdinalIgnoreCase)) return OperatorActionRisk.Low;
                if (string.Equals(p, "/revit/regenerate", StringComparison.OrdinalIgnoreCase)) return OperatorActionRisk.Low;
                if (string.Equals(p, "/revit/computer-use-observe", StringComparison.OrdinalIgnoreCase)) return OperatorActionRisk.Low;
                if (string.Equals(p, "/revit/computer-use-act", StringComparison.OrdinalIgnoreCase)) return OperatorActionRisk.Medium;
                if (string.Equals(p, "/revit/computer-use-guard", StringComparison.OrdinalIgnoreCase)) return OperatorActionRisk.Medium;
                if (string.Equals(p, "/revit/open-model", StringComparison.OrdinalIgnoreCase)) return OperatorActionRisk.High;
                if (string.Equals(p, "/revit/close-active-model", StringComparison.OrdinalIgnoreCase)) return OperatorActionRisk.High;
                if (string.Equals(p, "/revit/save-as", StringComparison.OrdinalIgnoreCase)) return OperatorActionRisk.High;
                if (string.Equals(p, "/revit/sync", StringComparison.OrdinalIgnoreCase)) return OperatorActionRisk.High;
                if (string.Equals(p, "/revit/worksets", StringComparison.OrdinalIgnoreCase)) return OperatorActionRisk.High;
                if (string.Equals(p, "/revit/project-parameters", StringComparison.OrdinalIgnoreCase)) return OperatorActionRisk.High;
                if (string.Equals(p, "/revit/purge-unused", StringComparison.OrdinalIgnoreCase)) return OperatorActionRisk.High;
                if (string.Equals(p, "/revit/transfer-view-templates", StringComparison.OrdinalIgnoreCase)) return OperatorActionRisk.High;

                // Planning helpers (may lead to writes, but this call should not apply them).
                if (string.Equals(p, "/revit/transaction-plan", StringComparison.OrdinalIgnoreCase)) return OperatorActionRisk.Medium;
                if (string.Equals(p, "/revit/transaction-validate", StringComparison.OrdinalIgnoreCase)) return OperatorActionRisk.Medium;

                // Applying a plan is model-modifying.
                if (string.Equals(p, "/revit/transaction-apply", StringComparison.OrdinalIgnoreCase)) return OperatorActionRisk.High;

                // Model manipulation primitives.
                if (string.Equals(p, "/revit/move-elements", StringComparison.OrdinalIgnoreCase)) return OperatorActionRisk.High;
                if (string.Equals(p, "/revit/rotate-elements", StringComparison.OrdinalIgnoreCase)) return OperatorActionRisk.High;
                if (string.Equals(p, "/revit/align-elements", StringComparison.OrdinalIgnoreCase)) return OperatorActionRisk.High;
                if (string.Equals(p, "/revit/room-align-wall-to-nearest-column", StringComparison.OrdinalIgnoreCase)) return OperatorActionRisk.High;
                if (string.Equals(p, "/revit/align-room-tops-to-ceilings", StringComparison.OrdinalIgnoreCase)) return OperatorActionRisk.High;
                if (string.Equals(p, "/revit/place-family-instance-on-host", StringComparison.OrdinalIgnoreCase)) return OperatorActionRisk.High;
                if (string.Equals(p, "/revit/create-similar-from-instance", StringComparison.OrdinalIgnoreCase)) return OperatorActionRisk.High;
                if (string.Equals(p, "/revit/adjust-hosted-instance-on-host", StringComparison.OrdinalIgnoreCase)) return OperatorActionRisk.High;
                if (string.Equals(p, "/revit/assign-electrical-circuit", StringComparison.OrdinalIgnoreCase)) return OperatorActionRisk.High;
                if (string.Equals(p, "/revit/assign-electrical-distribution-system", StringComparison.OrdinalIgnoreCase)) return OperatorActionRisk.High;

                // Drafting / annotation.
                if (string.Equals(p, "/revit/visibility", StringComparison.OrdinalIgnoreCase)) return OperatorActionRisk.Medium;
                if (string.Equals(p, "/revit/datums", StringComparison.OrdinalIgnoreCase)) return OperatorActionRisk.Medium;
                if (string.Equals(p, "/revit/create-text", StringComparison.OrdinalIgnoreCase)) return OperatorActionRisk.Medium;
                if (string.Equals(p, "/revit/keynotes", StringComparison.OrdinalIgnoreCase)) return OperatorActionRisk.Medium;
                if (string.Equals(p, "/revit/import-drawing-spec", StringComparison.OrdinalIgnoreCase)) return OperatorActionRisk.Medium;
                if (string.Equals(p, "/revit/import-excel-table", StringComparison.OrdinalIgnoreCase)) return OperatorActionRisk.Medium;
                if (string.Equals(p, "/revit/import-elements-xlsx-updates", StringComparison.OrdinalIgnoreCase)) return OperatorActionRisk.High;
                if (string.Equals(p, "/revit/create-drafting-view", StringComparison.OrdinalIgnoreCase)) return OperatorActionRisk.Medium;
                if (string.Equals(p, "/revit/create-view", StringComparison.OrdinalIgnoreCase)) return OperatorActionRisk.High;
                if (string.Equals(p, "/revit/draw-detail-curves", StringComparison.OrdinalIgnoreCase)) return OperatorActionRisk.Medium;
                if (string.Equals(p, "/revit/create-filled-region", StringComparison.OrdinalIgnoreCase)) return OperatorActionRisk.Medium;
                if (string.Equals(p, "/revit/create-revision-cloud", StringComparison.OrdinalIgnoreCase)) return OperatorActionRisk.Medium;
                if (string.Equals(p, "/revit/tag-elements", StringComparison.OrdinalIgnoreCase)) return OperatorActionRisk.Medium;
                if (string.Equals(p, "/revit/create-dimension", StringComparison.OrdinalIgnoreCase)) return OperatorActionRisk.Medium;
                if (string.Equals(p, "/revit/create-zone-visuals", StringComparison.OrdinalIgnoreCase)) return OperatorActionRisk.Medium;
                if (string.Equals(p, "/revit/fire-alarm-visualizer", StringComparison.OrdinalIgnoreCase)) return OperatorActionRisk.Medium;
                if (string.Equals(p, "/revit/create-print-set", StringComparison.OrdinalIgnoreCase)) return OperatorActionRisk.High;
                if (string.Equals(p, "/revit/create-revision", StringComparison.OrdinalIgnoreCase)) return OperatorActionRisk.High;
                if (string.Equals(p, "/revit/apply-revision-to-sheets", StringComparison.OrdinalIgnoreCase)) return OperatorActionRisk.High;
                if (string.Equals(p, "/revit/create-schedule", StringComparison.OrdinalIgnoreCase)) return OperatorActionRisk.High;
                if (string.Equals(p, "/revit/configure-schedule", StringComparison.OrdinalIgnoreCase)) return OperatorActionRisk.High;
                if (string.Equals(p, "/revit/update-schedule-cell", StringComparison.OrdinalIgnoreCase)) return OperatorActionRisk.High;
                if (string.Equals(p, "/revit/replace-schedule-values", StringComparison.OrdinalIgnoreCase)) return OperatorActionRisk.High;

                // External references placed on sheets are always model-modifying and should be approval-gated.
                if (string.Equals(p, "/revit/link-cad", StringComparison.OrdinalIgnoreCase)) return OperatorActionRisk.High;
                if (string.Equals(p, "/revit/link-revit", StringComparison.OrdinalIgnoreCase)) return OperatorActionRisk.High;
                if (string.Equals(p, "/revit/place-image", StringComparison.OrdinalIgnoreCase)) return OperatorActionRisk.High;
                if (string.Equals(p, "/revit/place-pdf-underlay", StringComparison.OrdinalIgnoreCase)) return OperatorActionRisk.High;
                if (string.Equals(p, "/revit/import-zippybim-geometry", StringComparison.OrdinalIgnoreCase)) return OperatorActionRisk.High;

                // Views/sheets automation.
                if (string.Equals(p, "/revit/create-sheets", StringComparison.OrdinalIgnoreCase)) return OperatorActionRisk.High;
                if (string.Equals(p, "/revit/duplicate-sheet", StringComparison.OrdinalIgnoreCase)) return OperatorActionRisk.High;
                if (string.Equals(p, "/revit/place-views", StringComparison.OrdinalIgnoreCase)) return OperatorActionRisk.High;
                if (string.Equals(p, "/revit/align-viewports", StringComparison.OrdinalIgnoreCase)) return OperatorActionRisk.High;
                if (string.Equals(p, "/revit/renumber-sheets", StringComparison.OrdinalIgnoreCase)) return OperatorActionRisk.High;
                if (string.Equals(p, "/revit/sync-sheet-names", StringComparison.OrdinalIgnoreCase)) return OperatorActionRisk.High;

                // Everything else is assumed model-modifying until we add more granular controls.
                return OperatorActionRisk.High;
            }

            return OperatorActionRisk.High;
        }

        public static OperatorActionRisk GetRisk(string method, string path, string? body)
        {
            var m = (method ?? "").Trim().ToUpperInvariant();
            var p = (path ?? "").Trim();

            if (m == "POST" && HasMutatingBody(p, body))
            {
                return OperatorActionRisk.High;
            }

            // Delete previews are safe only for the exact legacy apply:false contract.
            // Do not treat generic dryRun payloads or property-name variants as equivalent.
            if (m == "POST" &&
                string.Equals(p, "/revit/delete", StringComparison.OrdinalIgnoreCase) &&
                HasExactDeletePreviewContract(body))
            {
                return OperatorActionRisk.Low;
            }

            return GetRisk(m, p);
        }

        public static OperatorActionEffect GetEffect(string method, string path, string? body)
        {
            var m = (method ?? "").Trim().ToUpperInvariant();
            var p = (path ?? "").Trim();

            if (m == "GET") return OperatorActionEffect.Read;

            if (m == "POST" &&
                string.Equals(p, "/revit/transaction-plan", StringComparison.OrdinalIgnoreCase))
            {
                return OperatorActionEffect.Preview;
            }

            if (m == "POST" && HasMutatingBody(p, body))
            {
                if (string.Equals(p, "/revit/list-element-types", StringComparison.OrdinalIgnoreCase) &&
                    BodyHasTrueProperty(body, "dryRun"))
                {
                    return OperatorActionEffect.Preview;
                }

                return OperatorActionEffect.Apply;
            }

            if (m == "POST" &&
                string.Equals(p, "/revit/delete", StringComparison.OrdinalIgnoreCase) &&
                HasExactDeletePreviewContract(body))
            {
                return OperatorActionEffect.Preview;
            }

            var risk = GetRisk(m, p, body);
            if (risk == OperatorActionRisk.Low) return OperatorActionEffect.Read;
            if (m == "POST" && BodyRequestsPreview(body)) return OperatorActionEffect.Preview;
            return OperatorActionEffect.Apply;
        }

        public static string GetEffectWireValue(string method, string path, string? body)
        {
            switch (GetEffect(method, path, body))
            {
                case OperatorActionEffect.Read:
                    return "read";
                case OperatorActionEffect.Preview:
                    return "preview";
                default:
                    return "apply";
            }
        }

        private static bool HasMutatingBody(string path, string? body)
        {
            if (string.IsNullOrWhiteSpace(body)) return false;

            try
            {
                using var document = JsonDocument.Parse(body!);
                if (document.RootElement.ValueKind != JsonValueKind.Object) return false;
                var root = document.RootElement;

                if (string.Equals(path, "/revit/fire-damper-audit", StringComparison.OrdinalIgnoreCase))
                {
                    return HasStringValue(root, "command", "fix");
                }

                if (string.Equals(path, "/revit/lighting-audit", StringComparison.OrdinalIgnoreCase))
                {
                    return HasTrueValue(root, "fix") || HasTrueValue(root, "visualize");
                }

                if (string.Equals(path, "/revit/list-element-types", StringComparison.OrdinalIgnoreCase))
                {
                    return HasStringValue(root, "action", "rename_types") ||
                           HasStringValue(root, "action", "purge_unused_in_family");
                }

                return false;
            }
            catch
            {
                return false;
            }
        }

        private static bool HasStringValue(JsonElement root, string propertyName, string expectedValue)
        {
            return root.TryGetProperty(propertyName, out var property) &&
                   property.ValueKind == JsonValueKind.String &&
                   string.Equals(property.GetString()?.Trim(), expectedValue, StringComparison.OrdinalIgnoreCase);
        }

        private static bool HasTrueValue(JsonElement root, string propertyName)
        {
            return root.TryGetProperty(propertyName, out var property) && property.ValueKind == JsonValueKind.True;
        }

        private static bool BodyHasTrueProperty(string? body, string propertyName)
        {
            if (string.IsNullOrWhiteSpace(body)) return false;
            try
            {
                using var document = JsonDocument.Parse(body!);
                return document.RootElement.ValueKind == JsonValueKind.Object &&
                       HasTrueValue(document.RootElement, propertyName);
            }
            catch
            {
                return false;
            }
        }

        private static bool BodyRequestsPreview(string? body)
        {
            if (string.IsNullOrWhiteSpace(body)) return false;
            try
            {
                using var document = JsonDocument.Parse(body!);
                if (document.RootElement.ValueKind != JsonValueKind.Object) return false;
                var root = document.RootElement;
                return HasTrueValue(root, "dryRun") ||
                       HasTrueValue(root, "dry_run") ||
                       (root.TryGetProperty("apply", out var apply) && apply.ValueKind == JsonValueKind.False);
            }
            catch
            {
                return false;
            }
        }

        private static bool HasExactDeletePreviewContract(string? body)
        {
            if (string.IsNullOrWhiteSpace(body)) return false;

            try
            {
                using var document = JsonDocument.Parse(body!);
                if (document.RootElement.ValueKind != JsonValueKind.Object) return false;

                var foundApply = false;
                foreach (var property in document.RootElement.EnumerateObject())
                {
                    if (string.Equals(property.Name, "apply", StringComparison.Ordinal))
                    {
                        if (foundApply || property.Value.ValueKind != JsonValueKind.False) return false;
                        foundApply = true;
                    }
                    else if (string.Equals(property.Name, "apply", StringComparison.OrdinalIgnoreCase))
                    {
                        // Reject casing variants rather than relying on serializer behavior.
                        return false;
                    }
                }

                return foundApply;
            }
            catch
            {
                return false;
            }
        }

        public static bool RequiresApproval(OperatorApprovalMode mode, OperatorActionRisk risk)
        {
            if (mode == OperatorApprovalMode.Yolo) return false;
            if (mode == OperatorApprovalMode.AllowWritesThisSession) return false;

            // Safe mode: require approval for anything that might modify the model.
            return risk >= OperatorActionRisk.High;
        }
    }
}
