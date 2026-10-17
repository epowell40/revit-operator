using System;
using System.Collections.Generic;
using System.Text.Json;

namespace RevitBridge.Common
{
    public sealed class OperatorRevitBatchTerminalOutcome
    {
        private static readonly HashSet<string> AllowedEffectStates = new HashSet<string>(StringComparer.Ordinal)
        {
            "none",
            "applied",
            "unknown"
        };

        public bool Ok { get; }
        public string Error { get; }
        public string TerminalReason { get; }
        public string EffectState { get; }
        public bool Retryable { get; }
        public bool ReconciliationRequired { get; }
        public object WireResult { get; }

        private OperatorRevitBatchTerminalOutcome(
            bool ok,
            string error,
            string terminalReason,
            string effectState,
            object wireResult)
        {
            if (!AllowedEffectStates.Contains(effectState))
                throw new ArgumentException("effectState must be none, applied, or unknown.", nameof(effectState));

            Ok = ok;
            Error = error;
            TerminalReason = terminalReason;
            EffectState = effectState;
            Retryable = !ok && string.Equals(effectState, "none", StringComparison.Ordinal);
            ReconciliationRequired = !ok && !string.Equals(effectState, "none", StringComparison.Ordinal);
            WireResult = wireResult;
        }

        public static OperatorRevitBatchTerminalOutcome Succeeded(string assistantMessage, object rounds, string effectState)
        {
            return new OperatorRevitBatchTerminalOutcome(
                true,
                "",
                "completed",
                effectState,
                new Dictionary<string, object?>(StringComparer.Ordinal)
                {
                    ["ok"] = true,
                    ["effect_state"] = effectState,
                    ["assistant_message"] = assistantMessage ?? "",
                    ["rounds"] = rounds
                });
        }

        public static OperatorRevitBatchTerminalOutcome Failed(
            string error,
            string terminalReason,
            string effectState,
            string assistantMessage,
            object rounds)
        {
            if (string.IsNullOrWhiteSpace(error)) throw new ArgumentException("error is required.", nameof(error));
            if (string.IsNullOrWhiteSpace(terminalReason)) throw new ArgumentException("terminalReason is required.", nameof(terminalReason));

            var retryable = string.Equals(effectState, "none", StringComparison.Ordinal);
            var reconciliationRequired = !string.Equals(effectState, "none", StringComparison.Ordinal);
            var wireResult = new Dictionary<string, object?>(StringComparer.Ordinal)
            {
                ["ok"] = false,
                ["error"] = error,
                ["terminal_reason"] = terminalReason,
                ["retryable"] = retryable,
                ["effect_state"] = effectState,
                ["reconciliation_required"] = reconciliationRequired,
                ["assistant_message"] = assistantMessage ?? "",
                ["rounds"] = rounds
            };
            return new OperatorRevitBatchTerminalOutcome(false, error, terminalReason, effectState, wireResult);
        }

        public static bool TryGetTopLevelHandlerFailure(object? handlerResult, out string error)
        {
            error = "";
            if (handlerResult == null) return false;

            try
            {
                var root = handlerResult is JsonElement element
                    ? element
                    : JsonSerializer.SerializeToElement(handlerResult);
                if (root.ValueKind != JsonValueKind.Object) return false;

                JsonElement ok = default;
                var hasOk = false;
                foreach (var property in root.EnumerateObject())
                {
                    if (!string.Equals(property.Name, "ok", StringComparison.OrdinalIgnoreCase)) continue;
                    ok = property.Value;
                    hasOk = true;
                    break;
                }
                if (!hasOk || ok.ValueKind != JsonValueKind.False) return false;

                foreach (var property in root.EnumerateObject())
                {
                    if ((!string.Equals(property.Name, "error", StringComparison.OrdinalIgnoreCase) &&
                         !string.Equals(property.Name, "message", StringComparison.OrdinalIgnoreCase)) ||
                        property.Value.ValueKind != JsonValueKind.String)
                    {
                        continue;
                    }

                    error = (property.Value.GetString() ?? "").Trim();
                    if (!string.IsNullOrWhiteSpace(error)) break;
                }

                if (string.IsNullOrWhiteSpace(error)) error = "The Revit handler returned ok=false.";
                return true;
            }
            catch
            {
                // An uninspectable result is not proof that the handler reported failure.
                return false;
            }
        }
    }
}
