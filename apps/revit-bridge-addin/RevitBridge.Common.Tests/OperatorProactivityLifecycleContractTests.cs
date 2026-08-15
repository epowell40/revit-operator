using System;
using System.IO;
using System.Linq;
using Xunit;

namespace RevitBridge.Common.Tests
{
    public sealed class OperatorProactivityLifecycleContractTests
    {
        [Fact]
        public void WarningsWatcherCannotPermanentlyOccupyTheExternalEventQueue()
        {
            var source = ReadRepoFile(
                "apps", "revit-bridge-addin", "RevitBridge", "Operator", "OperatorProactivityService.cs");
            Assert.Contains("private async Task WarningsWatcherLoopAsync", source);
            Assert.Contains("CancellationTokenSource.CreateLinkedTokenSource(cancellationToken)", source);
            Assert.Contains("hostReadTimeout.CancelAfter(TimeSpan.FromSeconds(5))", source);
            Assert.Contains("}, hostReadTimeout.Token).ConfigureAwait(false);", source);
        }

        [Fact]
        public void CourierClaimsOnlyContextFreeBootstrapWorkUntilAHostDocumentIsOpen()
        {
            var worker = ReadRepoFile(
                "revit-bridge-addin", "RevitBridge", "Operator", "OperatorRevitCourierWorker.cs");
            var app = ReadRepoFile("revit-bridge-addin", "RevitBridge", "App.cs");

            Assert.Contains("var contextFreeOnly = Volatile.Read(ref _hostDocumentAvailable) == 0", worker);
            Assert.True(
                worker.IndexOf("var contextFreeOnly = Volatile.Read(ref _hostDocumentAvailable) == 0", StringComparison.Ordinal)
                < worker.IndexOf("ClaimNextRevitCourierJobJsonAsync", StringComparison.Ordinal));
            Assert.Contains("ClaimNextRevitCourierJobJsonAsync(null, _executorId, contextFreeOnly", worker);
            Assert.Contains("contextFreeOnly && !IsContextFreeWithoutDocument(method, path)", worker);
            Assert.Contains("/revit/open-model", worker);
            Assert.Contains("/revit/ping", worker);
            Assert.DoesNotContain("if (Volatile.Read(ref _hostDocumentAvailable) == 0) return", worker);
            Assert.Contains("application.Idling += OnIdling", app);
            Assert.Contains("uiApplication.ActiveUIDocument?.Document != null", app);
            Assert.Contains("_revitCourierWorker?.SetHostDocumentAvailable()", app);
            Assert.Contains("_revitCourierWorker?.SetHostDocumentUnavailable()", app);
            Assert.DoesNotContain("_openDocumentCount", app);
            Assert.DoesNotContain("Interlocked.Decrement", app);
            Assert.Contains("_eventService?.ExecutePendingOnIdling(uiApplication)", app);
            Assert.Contains("_eventService?.HasPendingWork == true", app);
            Assert.Contains("args.SetRaiseWithoutDelay()", app);
            Assert.DoesNotContain("SetHostDocumentAvailableAfterDelay", app);

            var eventService = ReadRepoFile(
                "revit-bridge-addin", "RevitBridge", "Services", "RevitEventService.cs");
            Assert.Contains("internal bool ExecutePendingOnIdling(UIApplication app)", eventService);
            Assert.Contains("if (_queue.IsEmpty) return false", eventService);
            Assert.Contains("Execute(app)", eventService);
            Assert.Contains("MaintainRaiseUntilStartedAsync(item)", eventService);
            Assert.Contains("TimeSpan.FromMilliseconds(250)", eventService);
            Assert.Contains("PostMessage(windowHandle, WmNull", eventService);
            Assert.Contains("SignalHostMessageLoop();", eventService);
            Assert.DoesNotContain("if (request == ExternalEventRequest.Accepted) return", eventService);
            Assert.DoesNotContain("revit_external_event_still_pending", eventService);
        }

        private static string ReadRepoFile(params string[] relativeSegments)
        {
            var cursor = new DirectoryInfo(AppContext.BaseDirectory);
            while (cursor != null)
            {
                var candidate = Path.Combine(new[] { cursor.FullName }.Concat(relativeSegments).ToArray());
                if (File.Exists(candidate)) return File.ReadAllText(candidate);
                cursor = cursor.Parent;
            }

            throw new FileNotFoundException("Could not locate repository source file.", Path.Combine(relativeSegments));
        }
    }
}
