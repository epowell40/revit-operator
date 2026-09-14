using System;
using System.Text.Json;
using System.Threading;

namespace RevitBridge.Common
{
    /// <summary>Immutable UI identity only. Never an element read or an edit verification receipt.</summary>
    public sealed class OperatorUiContextSnapshotStore
    {
        private readonly object _gate = new object();
        private long _revision;
        private string _snapshot = "{\"schema\":\"revit-operator.ui-context/v1\",\"state\":\"unavailable\",\"revision\":0,\"context\":null}";

        public string ReadJson() => Volatile.Read(ref _snapshot);

        public void Publish(string contextJson, DateTimeOffset capturedAt)
        {
            using var document = JsonDocument.Parse(contextJson);
            if (document.RootElement.ValueKind != JsonValueKind.Object)
                throw new ArgumentException("UI context must be an object.", nameof(contextJson));
            lock (_gate)
            {
                Volatile.Write(ref _snapshot, JsonSerializer.Serialize(new
                {
                    schema = "revit-operator.ui-context/v1", state = "available",
                    revision = ++_revision, captured_at_utc = capturedAt.ToUniversalTime().ToString("o"),
                    authority = "ui_identity_only", context = document.RootElement
                }));
            }
        }

        public void Invalidate(string reason)
        {
            lock (_gate)
            {
                Volatile.Write(ref _snapshot, JsonSerializer.Serialize(new
                {
                    schema = "revit-operator.ui-context/v1", state = "unavailable",
                    revision = ++_revision, reason, context = (object?)null
                }));
            }
        }
    }
}
