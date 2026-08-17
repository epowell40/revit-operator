using System;
using System.IO;
using Xunit;

namespace RevitBridge.Common.Tests
{
    public class HostedPlacementDryRunContractTests
    {
        [Fact]
        public void HostedPlacementDryRunsCaptureAndDeleteWarningsBeforeCommit()
        {
            var root = FindRevitBridgeAddinRoot();
            var source = File.ReadAllText(Path.Combine(root, "RevitBridge.Logic", "Handlers", "HostedPlacementHandlers.cs"));

            AssertSafeDryRunTransaction(
                Slice(source, "Place Family Instance On Host (Dry Run)", "status = placementValidation?.valid == false ? \"InvalidPreview\" : \"Planned\"")
            );
            AssertSafeDryRunTransaction(
                Slice(source, "Create Similar From Instance (Dry Run)", "status = placementValidation?.valid == false ? \"InvalidPreview\" : \"Planned\"")
            );
        }

        [Fact]
        public void ExplicitEmptySheetRenumberPreviewIsAReadOnlyNoOp()
        {
            var root = FindRevitBridgeAddinRoot();
            var source = File.ReadAllText(Path.Combine(root, "RevitBridge", "Handlers", "RenumberSheetsHandler.cs"));

            Assert.Contains("if (p.changes == null) throw new InvalidOperationException", source, StringComparison.Ordinal);
            Assert.Contains("if (dryRun && p.changes.Count == 0)", source, StringComparison.Ordinal);
            Assert.Contains("status = \"NoOp\"", source, StringComparison.Ordinal);
            Assert.Contains("candidateCount = 0", source, StringComparison.Ordinal);
            Assert.Contains("modelModified = false", source, StringComparison.Ordinal);
            Assert.Contains("completionEligible = false", source, StringComparison.Ordinal);
        }

        private static void AssertSafeDryRunTransaction(string source)
        {
            Assert.Contains("ConfigureFailureCapture(tx, failures, rollbackOnErrors: true, deleteWarnings: true)", source, StringComparison.Ordinal);
            Assert.Contains("var st = tx.Commit();", source, StringComparison.Ordinal);
            Assert.Contains("st != TransactionStatus.Committed", source, StringComparison.Ordinal);
            Assert.Contains("tx.GetStatus() == TransactionStatus.Started", source, StringComparison.Ordinal);
            Assert.Contains("tx.RollBack()", source, StringComparison.Ordinal);
            Assert.Contains("transactionStatus", source, StringComparison.Ordinal);
            Assert.Contains("failures", source, StringComparison.Ordinal);
        }

        private static string Slice(string source, string startMarker, string endMarker)
        {
            var start = source.IndexOf(startMarker, StringComparison.Ordinal);
            Assert.True(start >= 0, $"Missing source marker: {startMarker}");
            var end = source.IndexOf(endMarker, start, StringComparison.Ordinal);
            Assert.True(end > start, $"Missing source marker after {startMarker}: {endMarker}");
            return source.Substring(start, end - start);
        }

        private static string FindRevitBridgeAddinRoot()
        {
            var current = new DirectoryInfo(AppContext.BaseDirectory);
            while (current != null)
            {
                var publicRoot = Path.Combine(current.FullName, "apps", "revit-bridge-addin");
                if (Directory.Exists(publicRoot)) return publicRoot;
                var privateRoot = Path.Combine(current.FullName, "revit-bridge-addin");
                if (Directory.Exists(privateRoot)) return privateRoot;
                current = current.Parent;
            }
            throw new DirectoryNotFoundException("Revit bridge add-in root not found.");
        }
    }
}
