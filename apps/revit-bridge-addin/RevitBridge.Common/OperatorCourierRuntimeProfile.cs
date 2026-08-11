using System;
using System.Collections.Generic;
using System.Text.Json;
using System.Text.RegularExpressions;

namespace RevitBridge.Common
{
    /// <summary>
    /// Legacy courier execution is deliberately confined to the one explicit
    /// local laboratory profile. Callers must not normalize, default, or infer
    /// these values because that would make v1 executable by accident.
    /// </summary>
    public static class OperatorCourierRuntimeProfile
    {
        private static readonly Regex Alias = new Regex("^[a-z][a-z0-9_]{0,127}$", RegexOptions.CultureInvariant);
        private static readonly Regex Hash = new Regex("^sha256:[0-9a-f]{64}$", RegexOptions.CultureInvariant);
        private static readonly HashSet<string> Channels = new HashSet<string>(StringComparer.Ordinal)
        {
            "search", "generic_call", "typed_mcp", "deterministic_workflow"
        };
        private static readonly HashSet<string> GeneralAdmissionFields = new HashSet<string>(StringComparer.Ordinal)
        {
            "schema", "source", "runtime_mode", "exposure_profile", "capability_profile", "general_agent_ready",
            "method", "path", "channel", "alias", "request_hash", "effect_hash"
        };

        public static bool IsExactDevelopmentLaboratory(string? runtimeMode, string? exposureProfile)
        {
            return string.Equals(runtimeMode, "development", StringComparison.Ordinal)
                && string.Equals(exposureProfile, "laboratory", StringComparison.Ordinal);
        }

        /// <summary>
        /// Validates the explicit hosted General Agent admission carried by a v1
        /// courier job. The job itself arrives through the authenticated backend
        /// channel; this binding prevents raw bearer persistence and ties the
        /// admitted MCP alias to the exact method and path delivered to Revit.
        /// </summary>
        public static bool TryValidateGeneralAgentJob(JsonElement job, out string error)
        {
            error = "";
            if (!job.TryGetProperty("general_agent_admission", out var admission) || admission.ValueKind != JsonValueKind.Object)
            {
                error = "General Agent courier admission is missing.";
                return false;
            }
            var fieldCount = 0;
            foreach (var property in admission.EnumerateObject())
            {
                fieldCount++;
                if (!GeneralAdmissionFields.Contains(property.Name))
                {
                    error = "General Agent courier admission contains an unexpected field.";
                    return false;
                }
            }
            if (fieldCount != GeneralAdmissionFields.Count
                || !ExactString(admission, "schema", "revit-operator.general-agent-courier-admission.v1")
                || !ExactString(admission, "source", "backend_general_agent")
                || !(ExactString(admission, "runtime_mode", "hosted") || ExactString(admission, "runtime_mode", "production"))
                || !ExactString(admission, "exposure_profile", "general")
                || !ExactString(admission, "capability_profile", "general_agent")
                || !admission.TryGetProperty("general_agent_ready", out var ready) || ready.ValueKind != JsonValueKind.True)
            {
                error = "General Agent courier admission profile is malformed.";
                return false;
            }
            var method = RequiredString(job, "method");
            var path = RequiredString(job, "path");
            var admittedMethod = RequiredString(admission, "method");
            var admittedPath = RequiredString(admission, "path");
            var channel = RequiredString(admission, "channel");
            var alias = RequiredString(admission, "alias");
            var requestHash = RequiredString(admission, "request_hash");
            var effectHash = RequiredString(admission, "effect_hash");
            if ((method != "GET" && method != "POST") || admittedMethod != method || admittedPath != path
                || !Channels.Contains(channel ?? "") || !Alias.IsMatch(alias ?? "")
                || !Hash.IsMatch(requestHash ?? "") || !Hash.IsMatch(effectHash ?? "")
                || job.TryGetProperty("turn_token", out _)
                || !job.TryGetProperty("turn_token_sha256", out var tokenHash)
                || (tokenHash.ValueKind != JsonValueKind.Null
                    && (tokenHash.ValueKind != JsonValueKind.String || !Hash.IsMatch(tokenHash.GetString() ?? ""))))
            {
                error = "General Agent courier admission does not bind the exact route, alias, or bearer-token digest.";
                return false;
            }
            return true;
        }

        private static bool ExactString(JsonElement value, string property, string expected)
        {
            return value.TryGetProperty(property, out var item)
                && item.ValueKind == JsonValueKind.String
                && string.Equals(item.GetString(), expected, StringComparison.Ordinal);
        }

        private static string? RequiredString(JsonElement value, string property)
        {
            return value.TryGetProperty(property, out var item) && item.ValueKind == JsonValueKind.String
                ? item.GetString()
                : null;
        }
    }
}
