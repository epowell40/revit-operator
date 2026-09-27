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

        [Fact]
        public void ReroutePlanningAndBothWriteBranchesReturnObservedNativeReceipts()
        {
            var source = Environment.GetEnvironmentVariable("OPERATOR_REROUTE_HANDLER_SOURCE_FOR_TEST")
                ?? Path.Combine(FindRevitBridgeAddinRoot(), "RevitBridge.Logic", "Handlers", "MEP", "RerouteMepRouteSegmentHandler.cs");
            var handler = File.ReadAllText(source);
            Assert.Contains("var transactionReceipt = OperatorNativeTransactionReceipt.NotStarted();", handler, StringComparison.Ordinal);
            Assert.Contains("HandleCore(app, jsonData, ref transactionReceipt, nativeStages)", handler, StringComparison.Ordinal);
            Assert.Contains("ref OperatorNativeTransactionReceipt transactionReceipt", handler, StringComparison.Ordinal);
            Assert.Equal(2, handler.Split(new[] { "NativeSingleTransaction.Execute(" }, StringSplitOptions.None).Length - 1);
            Assert.Equal(2, handler.Split(new[] { "NativeNonInteractiveFailureHandling.Configure(" }, StringSplitOptions.None).Length - 1);
            Assert.Contains("transactionReceipt = (OperatorNativeTransactionReceipt)response[\"transaction\"]!", handler, StringComparison.Ordinal);
            Assert.Contains("transaction = transactionReceipt", handler, StringComparison.Ordinal);
            Assert.Contains("nativeCreated.Remove(deletedId)", handler, StringComparison.Ordinal);
            Assert.Contains("nativeDeletedElements: () => deletedOriginalIds", handler, StringComparison.Ordinal);
            Assert.Equal(2, handler.Split(new[] { "visualVerification = CaptureVisualWithObservedRollback(" }, StringSplitOptions.None).Length - 1);
            Assert.Contains("nativeStages[\"route\"] = transactionReceipt", handler, StringComparison.Ordinal);
            Assert.Contains("() => group.RollBack().ToString()", handler, StringComparison.Ordinal);
            Assert.Contains("() => group.GetStatus().ToString()", handler, StringComparison.Ordinal);
            Assert.Contains("disposition: NativeTransactionDisposition.Rollback", handler, StringComparison.Ordinal);
            Assert.Contains("visualReceipt.Status == \"rolled_back\" || visualReceipt.Status == \"not_started\"", handler, StringComparison.Ordinal);
            Assert.Contains("transactionReceipt = routeReceipt", handler, StringComparison.Ordinal);
            Assert.Contains("OperatorNativeTransactionReceipt.Unknown(\"visual_stage_unsettled\", routeReceipt.AffectedElementIds)", handler, StringComparison.Ordinal);
            Assert.DoesNotContain("tx.Commit()", handler, StringComparison.Ordinal);
            Assert.DoesNotContain("tx.RollBack()", handler, StringComparison.Ordinal);
            Assert.DoesNotContain("transaction was rolled back before committing", handler, StringComparison.Ordinal);
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
