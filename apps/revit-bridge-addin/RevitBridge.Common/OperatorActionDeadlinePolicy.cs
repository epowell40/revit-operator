using System;
using System.Collections.Generic;

namespace RevitBridge.Common
{
    public sealed class OperatorActionDeadline
    {
        public OperatorActionDeadline(string deadlineClass, TimeSpan budget)
        {
            DeadlineClass = deadlineClass;
            Budget = budget;
        }

        public string DeadlineClass { get; }
        public TimeSpan Budget { get; }
        public int BudgetMilliseconds => (int)Math.Min(int.MaxValue, Math.Max(1, Math.Ceiling(Budget.TotalMilliseconds)));

        public OperatorActionDeadline ConstrainTo(TimeSpan available)
        {
            if (available <= TimeSpan.Zero) throw new ArgumentOutOfRangeException(nameof(available));
            return new OperatorActionDeadline(DeadlineClass, available < Budget ? available : Budget);
        }

        public OperatorActionDeadlineExceededException CreateTimeoutException(string? correlationId)
            => new OperatorActionDeadlineExceededException(DeadlineClass, BudgetMilliseconds, correlationId);
    }

    public static class OperatorActionDeadlinePolicy
    {
        private static readonly HashSet<string> ControlPlanePaths = new HashSet<string>(StringComparer.OrdinalIgnoreCase)
        {
            "/revit/ping",
            "/revit/capabilities",
            "/revit/write-grant-status",
            "/revit/tool-registry",
            "/revit/tool-search",
            "/revit/tool-doc",
            "/revit/tool-examples",
            "/revit/native-api-policy",
            "/revit/native-api-catalog",
            "/revit/native-api-search"
        };

        private static readonly HashSet<string> ExtendedPaths = new HashSet<string>(StringComparer.OrdinalIgnoreCase)
        {
            "/revit/batch-job",
            "/revit/export-pdf",
            "/revit/print",
            "/revit/export-images",
            "/revit/export-dwg",
            "/revit/export-ifc",
            "/revit/export-elements-xlsx",
            "/revit/export-dimensioning-v2",
            "/revit/capture-sheet-region",
            "/revit/open-model",
            "/revit/save-as",
            "/revit/sync",
            "/revit/purge-unused",
            "/revit/transfer-view-templates",
            "/revit/load-family",
            "/revit/create-family-from-template",
            "/revit/reload-family-edit-session",
            "/revit/create-similar-from-instance",
            "/revit/place-family-instance-on-host",
            "/revit/existing-conditions-mep-draft-workflow"
        };

        public static OperatorActionDeadline Resolve(string? method, string? path, string? risk)
        {
            var normalizedPath = (path ?? "").Trim();
            if (ControlPlanePaths.Contains(normalizedPath))
                return new OperatorActionDeadline("control_plane", TimeSpan.FromSeconds(10));
            if (ExtendedPaths.Contains(normalizedPath))
                return new OperatorActionDeadline("extended", TimeSpan.FromSeconds(210));
            if (string.Equals(risk, "high", StringComparison.OrdinalIgnoreCase))
                return new OperatorActionDeadline("model_mutation", TimeSpan.FromSeconds(85));
            if (string.Equals(risk, "medium", StringComparison.OrdinalIgnoreCase))
                return new OperatorActionDeadline("interactive_or_export", TimeSpan.FromSeconds(75));
            return new OperatorActionDeadline("bounded_read", TimeSpan.FromSeconds(60));
        }
    }

    public static class OperatorCorrelationId
    {
        public static bool IsValid(string? value)
        {
            var candidate = (value ?? "").Trim();
            if (candidate.Length == 0 || candidate.Length > 160) return false;
            foreach (var ch in candidate)
            {
                if (!(char.IsLetterOrDigit(ch) || ch == '.' || ch == '_' || ch == ':' || ch == '-')) return false;
            }
            return true;
        }

        public static string NormalizeOrCreate(string? preferred, string? fallback = null)
        {
            var first = (preferred ?? "").Trim();
            if (IsValid(first)) return first;
            var second = (fallback ?? "").Trim();
            if (IsValid(second)) return second;
            return Guid.NewGuid().ToString("N");
        }
    }

    public interface IOperatorCorrelationMetadata
    {
        string? CorrelationId { get; }
    }

    public interface IOperatorActionDeadlineMetadata
    {
        string DeadlineClass { get; }
        int DeadlineMs { get; }
    }

    public sealed class OperatorActionDeadlineExceededException : TimeoutException,
        IOperatorRevitFailureMetadata,
        IOperatorCorrelationMetadata,
        IOperatorActionDeadlineMetadata
    {
        public OperatorActionDeadlineExceededException(string deadlineClass, int deadlineMs, string? correlationId)
            : base($"The Revit action exceeded its {deadlineClass} local deadline of {deadlineMs} ms; the outcome is unknown.")
        {
            DeadlineClass = deadlineClass;
            DeadlineMs = deadlineMs;
            CorrelationId = OperatorCorrelationId.IsValid(correlationId) ? correlationId!.Trim() : null;
        }

        public string Code => "revit_action_deadline_elapsed_outcome_unknown";
        public bool Retryable => false;
        public string Phase => "revit_external_event";
        public string HostHealth => "unavailable";
        public bool OpensCircuit => true;
        public bool OutcomeUnknown => true;
        public string? CorrelationId { get; }
        public string DeadlineClass { get; }
        public int DeadlineMs { get; }
    }
}
