using System;
using System.Collections.Generic;
using System.IO;
using Xunit;

namespace RevitBridge.Common.Tests
{
    public sealed class OperatorRevitQueueDiagnosticTests
    {
        [Fact]
        public void BusyTraceDistinguishesPendingAndExecutingOwnerFromRejectedRequest()
        {
            var owner = new OperatorRevitQueueDiagnostic(null, "http:GET:/revit/context");
            var rejected = new OperatorRevitQueueDiagnostic(null, "http:POST:/revit/replace-text-note");
            var lines = new List<string>();
            OperatorRevitQueueDiagnostic.Write(lines.Add, "busy", rejected, owner);
            Assert.Contains("owner=(id=" + owner.Id + " source=http:GET:/revit/context state=pending", lines[0]);
            Assert.Contains("id=" + rejected.Id + " source=http:POST:/revit/replace-text-note", lines[0]);
            owner.MarkStarted();
            OperatorRevitQueueDiagnostic.Write(lines.Add, "busy", rejected, owner);
            Assert.Contains("source=http:GET:/revit/context state=started", lines[1]);
            Assert.Contains("elapsed_ms=", lines[1]);
            Assert.NotEqual(owner.Id, rejected.Id);
        }

        [Fact]
        public void DiagnosticSinkFailureCannotEscapeIntoNativeDispatch()
        {
            OperatorRevitQueueDiagnostic.Write(_ => throw new IOException("locked log"), "started", new OperatorRevitQueueDiagnostic(null, "probe"));
            OperatorRevitQueueDiagnostic.Write(null, "busy", null);
        }

        [Fact]
        public void DiagnosticMetadataIsBoundedAndCannotInjectLogLines()
        {
            var value = new OperatorRevitQueueDiagnostic("bad\r\ncorrelation", "http:\r\n" + new string('x', 500));
            Assert.Equal(180, value.Source.Length);
            Assert.DoesNotContain("\r", value.Describe());
            Assert.DoesNotContain("\n", value.Describe());
            Assert.True(Guid.TryParse(value.Id, out _));
        }

        [Fact]
        public void ActualNativeEntryPointsSupplyRouteAndLifecycleDiagnostics()
        {
            var root = new DirectoryInfo(AppContext.BaseDirectory);
            while (root != null && !Directory.Exists(Path.Combine(root.FullName, "RevitBridge", "Services"))) root = root.Parent;
            Assert.NotNull(root);
            string Read(string path) => File.ReadAllText(Path.Combine(root!.FullName, "RevitBridge", path));
            var service = Read("Services/RevitEventService.cs");
            Assert.Contains("Volatile.Read(ref _diagnosticOwner)", service);
            Assert.Contains("item.Diagnostic?.MarkStarted()", service);
            Assert.Contains("\"cancellation_requested\"", service);
            Assert.Contains("\"released\"", service);
            Assert.Contains("new RevitEventService(WriteStartupLog)", Read("App.cs"));
            Assert.Contains("\"http:\" + effectiveMethod + \":\" + path", Read("Server/RevitHttpServer.cs"));
        }
    }
}
