using System;
using System.Collections.Generic;
using System.Linq;
using System.Security.Cryptography;
using System.Text;

namespace RevitBridge.Common
{
    public sealed class OperatorRevitBatchBinding
    {
        public string SessionId { get; }
        public string TargetExecutorId { get; }
        public string ProjectFingerprint { get; }
        public string DocumentTitle { get; }
        public string DocumentPath { get; }

        public OperatorRevitBatchBinding(
            string sessionId,
            string targetExecutorId,
            string projectFingerprint,
            string? documentTitle = null,
            string? documentPath = null)
        {
            SessionId = Required(sessionId, 200, nameof(sessionId));
            TargetExecutorId = Required(targetExecutorId, 160, nameof(targetExecutorId));
            ProjectFingerprint = Required(projectFingerprint, 64, nameof(projectFingerprint)).ToLowerInvariant();
            if (ProjectFingerprint.Length != 64 || ProjectFingerprint.Any(ch => !Uri.IsHexDigit(ch)))
                throw new ArgumentException("projectFingerprint must be a 64-character SHA-256 value.", nameof(projectFingerprint));
            DocumentTitle = Clip(documentTitle, 512);
            DocumentPath = Clip(documentPath, 2048);
        }

        public static OperatorRevitBatchBinding FromLiveDocument(
            string sessionId,
            string targetExecutorId,
            string? documentTitle,
            string? documentPath,
            string? projectUniqueId = null)
        {
            if (string.IsNullOrWhiteSpace(documentTitle) && string.IsNullOrWhiteSpace(documentPath))
                throw new InvalidOperationException("A live Revit document is required for batch binding.");
            return new OperatorRevitBatchBinding(
                sessionId,
                targetExecutorId,
                ComputeProjectFingerprint(documentTitle, documentPath, projectUniqueId),
                documentTitle,
                documentPath);
        }

        public static string ComputeProjectFingerprint(string? documentTitle, string? documentPath, string? projectUniqueId = null)
        {
            var normalizedUniqueId = (projectUniqueId ?? "").Trim().ToUpperInvariant();
            var normalizedPath = (documentPath ?? "").Trim().Replace('\\', '/').ToUpperInvariant();
            var normalizedTitle = (documentTitle ?? "").Trim().ToUpperInvariant();
            var identity = normalizedUniqueId.Length > 0
                ? "project-information-unique-id:" + normalizedUniqueId
                : normalizedPath.Length > 0 ? "path:" + normalizedPath : "title:" + normalizedTitle;
            if (identity.Length <= 6)
                throw new InvalidOperationException("A Revit document path or title is required to compute project identity.");
            using var sha256 = SHA256.Create();
            var digest = sha256.ComputeHash(Encoding.UTF8.GetBytes("revit-operator.project.v1\n" + identity));
            return string.Concat(digest.Select(value => value.ToString("x2")));
        }

        public bool Matches(OperatorRevitBatchBinding? other)
        {
            return other != null &&
                   string.Equals(SessionId, other.SessionId, StringComparison.Ordinal) &&
                   string.Equals(TargetExecutorId, other.TargetExecutorId, StringComparison.Ordinal) &&
                   string.Equals(ProjectFingerprint, other.ProjectFingerprint, StringComparison.OrdinalIgnoreCase);
        }

        public IDictionary<string, object?> ToWireValues()
        {
            return new Dictionary<string, object?>(StringComparer.Ordinal)
            {
                ["session_id"] = SessionId,
                ["target_executor_id"] = TargetExecutorId,
                ["project_fingerprint"] = ProjectFingerprint,
                ["target_context"] = new Dictionary<string, object?>(StringComparer.Ordinal)
                {
                    ["executor_id"] = TargetExecutorId,
                    ["project_fingerprint"] = ProjectFingerprint,
                    ["document_title"] = string.IsNullOrWhiteSpace(DocumentTitle) ? null : DocumentTitle,
                    ["document_path"] = string.IsNullOrWhiteSpace(DocumentPath) ? null : DocumentPath
                }
            };
        }

        private static string Required(string? value, int max, string field)
        {
            var normalized = Clip(value, max);
            if (string.IsNullOrWhiteSpace(normalized)) throw new ArgumentException(field + " is required.", field);
            return normalized;
        }

        private static string Clip(string? value, int max)
        {
            var normalized = (value ?? "").Trim();
            return normalized.Length <= max ? normalized : normalized.Substring(0, max);
        }
    }
}
