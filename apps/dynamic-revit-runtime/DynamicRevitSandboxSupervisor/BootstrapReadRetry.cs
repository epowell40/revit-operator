using System.Text.Json;

namespace RevitOperator.DynamicRevitSandboxSupervisor;

// This policy belongs only to the bootstrap read, before a worker is launched.
// Never reuse it for registration, preview, apply, or an uncertain host outcome.
internal static class BootstrapReadRetry
{
    internal const string Path = "/revit/dynamic-runtime/bootstrap";
    internal const int MaximumAttempts = 8;
    internal const string ExhaustedFailure = "Revit remained busy before generated-code startup. No worker was launched and no preview or apply was dispatched.";

    internal static async Task<BootstrapReadResult> SendAsync(Func<Task<HttpPostResult>> send, Func<TimeSpan, Task>? delay = null)
    {
        delay ??= duration => Task.Delay(duration);
        for (var attempt = 1; ; attempt++)
        {
            var response = await send();
            if (!IsUndispatchedBusyRead(response) || attempt == MaximumAttempts)
                return new BootstrapReadResult(response, attempt);
            // Seven finite delays total 14 seconds. The existing HTTP deadline
            // still bounds an individual request once Revit accepts it.
            await delay(TimeSpan.FromMilliseconds(500 * attempt));
        }
    }

    internal static bool IsUndispatchedBusyRead(HttpPostResult response)
    {
        if (response.Success || response.StatusCode != 409 || response.Body.Length > 16_384) return false;
        try
        {
            using var document = JsonDocument.Parse(response.Body);
            var root = document.RootElement;
            if (!Matches(root, "ok", false) || !Matches(root, "code", "revit_external_event_busy") ||
                !Matches(root, "retryable", true) || !Matches(root, "request_dispatched", false) ||
                !Matches(root, "outcome_unknown", false) ||
                !root.TryGetProperty("canonical_attempt_settlement", out var settlement)) return false;
            return Matches(settlement, "schema", "revit-operator.native-attempt-settlement.v1") &&
                Matches(settlement, "requested_effect", "read") && Matches(settlement, "method", "POST") &&
                Matches(settlement, "path", Path) && Matches(settlement, "request_dispatched", false) &&
                Matches(settlement, "effect_state", "none") && Matches(settlement, "effect_authority", "native_host") &&
                Matches(settlement, "effect_reason", "revit_external_event_busy") &&
                settlement.TryGetProperty("affected_target_identities", out var targets) &&
                targets.ValueKind == JsonValueKind.Array && targets.GetArrayLength() == 0;
        }
        catch (JsonException) { return false; }
    }

    private static bool Matches(JsonElement element, string name, string value) =>
        element.ValueKind == JsonValueKind.Object && element.TryGetProperty(name, out var property) &&
        property.ValueKind == JsonValueKind.String && property.GetString() == value;
    private static bool Matches(JsonElement element, string name, bool value) =>
        element.ValueKind == JsonValueKind.Object && element.TryGetProperty(name, out var property) &&
        property.ValueKind == (value ? JsonValueKind.True : JsonValueKind.False);
}

internal sealed record BootstrapReadResult(HttpPostResult Response, int Attempts);
