using System;
using System.IO;
using System.Linq;
using System.Text.Json;
using System.Threading.Tasks;
using RevitBridge.Common;
using Xunit;

namespace RevitBridge.Common.Tests
{
    public sealed class OperatorUiContextSnapshotTests
    {
        [Fact]
        public void UnavailableAndDocumentTransitionsNeverReturnThePreviousIdentity()
        {
            var store = new OperatorUiContextSnapshotStore();
            Assert.Contains("unavailable", store.ReadJson());
            store.Publish("{\"document\":{\"title\":\"Model A\"}}", DateTimeOffset.UtcNow);
            Assert.Contains("Model A", store.ReadJson());
            foreach (var transition in new[] { "document_opening", "document_closing", "document_closed", "view_activating", "revit_shutdown" })
            {
                store.Invalidate(transition);
                Assert.DoesNotContain("Model A", store.ReadJson());
                using var state = JsonDocument.Parse(store.ReadJson());
                Assert.Equal(JsonValueKind.Null, state.RootElement.GetProperty("context").ValueKind);
                store.Publish("{\"document\":{\"title\":\"Model A\"}}", DateTimeOffset.UtcNow);
            }
            store.Publish("{\"document\":null}", DateTimeOffset.UtcNow);
            Assert.Contains("available", store.ReadJson());
            Assert.DoesNotContain("Model A", store.ReadJson());
        }

        [Fact]
        public void BackgroundReadersSeeImmutableCompleteSnapshotsWithoutModelAuthority()
        {
            var store = new OperatorUiContextSnapshotStore();
            store.Publish("{\"document\":{\"title\":\"Model A\"}}", DateTimeOffset.UtcNow);
            var original = store.ReadJson();
            Parallel.For(0, 100, index => {
                if (index % 5 == 0) store.Publish("{\"document\":{\"title\":\"Model B\"}}", DateTimeOffset.UtcNow);
                using var snapshot = JsonDocument.Parse(store.ReadJson());
                Assert.Equal("ui_identity_only", snapshot.RootElement.GetProperty("authority").GetString());
                Assert.True(snapshot.RootElement.GetProperty("revision").GetInt64() >= 1);
                Assert.False(snapshot.RootElement.TryGetProperty("nativeExecutionAttestation", out _));
            });
            Assert.Contains("Model A", original);
            Assert.Contains("Model B", store.ReadJson());
        }

        [Fact]
        public void PingUsesOnlySerializedUiStateAndLifecycleEventsKeepItCurrent()
        {
            var app = ReadSource("RevitBridge", "App.cs");
            foreach (var eventName in new[] { "DocumentOpening", "DocumentOpened", "DocumentClosing", "DocumentClosed", "DocumentChanged", "DocumentSaved", "DocumentSavedAs", "ViewActivating", "ViewActivated", "SelectionChanged", "Idling" })
            {
                Assert.Contains(eventName + " +=", app);
                Assert.Contains(eventName + " -=", app);
            }
            Assert.Contains("RevitUiContextSnapshot.Capture(uiApplication)", app);
            var server = ReadSource("RevitBridge", "Server", "RevitHttpServer.cs");
            var ping = server.Substring(server.IndexOf("if (path == \"/revit/ping\")", StringComparison.Ordinal));
            ping = ping.Substring(0, ping.IndexOf("else if", StringComparison.Ordinal));
            Assert.Contains("RequireFinalNativeAuthorizationAsync", ping);
            Assert.Contains("ui_context = RevitUiContextSnapshot.Read()", ping);
            Assert.DoesNotContain("_eventService.Run", ping);
            var snapshot = ReadSource("RevitBridge", "Services", "RevitUiContextSnapshot.cs");
            var read = snapshot.Substring(snapshot.IndexOf("public static JsonElement Read()", StringComparison.Ordinal));
            read = read.Substring(0, read.IndexOf("public static void Shutdown", StringComparison.Ordinal));
            Assert.DoesNotContain("ActiveUIDocument", read);
            Assert.DoesNotContain("Selection", read);
            Assert.Contains("Store.ReadJson()", read);
        }

        private static string ReadSource(params string[] segments)
        {
            for (var cursor = new DirectoryInfo(AppContext.BaseDirectory); cursor != null; cursor = cursor.Parent)
            {
                var candidate = Path.Combine(new[] { cursor.FullName }.Concat(segments).ToArray());
                if (File.Exists(candidate)) return File.ReadAllText(candidate);
            }
            throw new FileNotFoundException(string.Join("/", segments));
        }
    }
}
