using System;
using System.IO;
using Xunit;

namespace RevitBridge.Common.Tests
{
    public class RevitRerouteOperationContractTests
    {
        [Fact]
        public void RerouteOperationIsExplicitAndRollbackWarningsCannotStrandARevitModal()
        {
            var root = FindRevitBridgeAddinRoot();
            var handler = File.ReadAllText(Path.Combine(root, "RevitBridge.Logic", "Handlers", "MEP", "RerouteMepRouteSegmentHandler.cs"));
            Assert.Contains("public string? operation { get; set; }", handler, StringComparison.Ordinal);
            Assert.Contains("requestedOperation == \"size_transition\"", handler, StringComparison.Ordinal);
            Assert.Contains("value == \"offset\" || value == \"size_transition\"", handler, StringComparison.Ordinal);

            var validator = File.ReadAllText(Path.Combine(root, "RevitBridge", "Operator", "OperatorActionSchemaValidator.cs"));
            Assert.Contains("ValidateOptionalEnum(obj, \"operation\", new[] { \"auto\", \"offset\", \"size_transition\" }", validator, StringComparison.Ordinal);
            Assert.Contains("requestedOperation != \"offset\" && transitionFieldsPresent", validator, StringComparison.Ordinal);

            var manifest = File.ReadAllText(Path.Combine(root, "RevitBridge", "Operator", "OperatorToolManifest.cs"));
            Assert.Contains("operation:\\\"offset\\\"", manifest, StringComparison.Ordinal);
            Assert.Contains("operation:\\\"size_transition\\\"", manifest, StringComparison.Ordinal);

            var gateway = File.ReadAllText(Path.Combine(root, "RevitBridge", "Operator", "OperatorNativeApiGateway.cs"));
            Assert.Contains("if (_transactionMode == \"rollback\" || !ScopeDecision.Allowed)", gateway, StringComparison.Ordinal);
            Assert.Contains("failuresAccessor.DeleteWarning(failure)", gateway, StringComparison.Ordinal);
        }

        private static string FindRevitBridgeAddinRoot()
        {
            var current = new DirectoryInfo(AppContext.BaseDirectory);
            while (current != null)
            {
                var publicRoot = Path.Combine(current.FullName, "apps", "revit-bridge-addin");
                if (File.Exists(Path.Combine(publicRoot, "RevitBridge", "Server", "RevitHttpServer.cs"))) return publicRoot;
                var privateRoot = Path.Combine(current.FullName, "revit-bridge-addin");
                if (File.Exists(Path.Combine(privateRoot, "RevitBridge", "Server", "RevitHttpServer.cs"))) return privateRoot;
                current = current.Parent;
            }
            throw new DirectoryNotFoundException("Revit bridge add-in root not found.");
        }
    }
}
