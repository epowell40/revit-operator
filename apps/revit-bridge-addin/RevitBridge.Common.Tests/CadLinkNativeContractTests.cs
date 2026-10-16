using System;
using System.IO;
using System.Linq;
using Xunit;

namespace RevitBridge.Common.Tests
{
    public sealed class CadLinkNativeContractTests
    {
        private static string Read(params string[] parts)
        {
            for (var dir = new DirectoryInfo(AppContext.BaseDirectory); dir != null; dir = dir.Parent)
            foreach (var prefix in new[] { new[] { "apps", "revit-bridge-addin", "RevitBridge" }, new[] { "revit-bridge-addin", "RevitBridge" } })
            {
                var file = Path.Combine(new[] { dir.FullName }.Concat(prefix).Concat(parts).ToArray());
                if (File.Exists(file)) return File.ReadAllText(file);
            }
            throw new FileNotFoundException("Native CAD source unavailable.");
        }

        [Fact]
        public void NativeResultMustMatchRequestedModeInsideAuthoritativeTransaction()
        {
            var source = Read("Handlers", "LinkCadHandler.cs");
            var transaction = source.IndexOf("NativeSingleTransaction.Execute", StringComparison.Ordinal);
            var selection = source.IndexOf("CadLinkOptionPolicy.ExecuteRequestedMode", StringComparison.Ordinal);
            var identity = source.IndexOf("[\"isLinked\"] = imported.IsLinked", StringComparison.Ordinal);
            Assert.True(transaction >= 0 && selection > transaction && identity > selection);
            Assert.Contains("OperatorNativeTransactionExecution.OutcomeStatus(result, \"Success\")", source);
            Assert.DoesNotContain("t.Commit()", source);
            Assert.DoesNotContain("if (!ok)", source);
            Assert.Contains("doc.Link(filePath, options, view, out elementId)", source);
            Assert.Contains("doc.Import(filePath, options, view, out elementId)", source);
            Assert.DoesNotContain("m.Invoke(doc", source);
            Assert.Contains("OperatorNativeTransactionReceipt.NotStarted()", source);
            Assert.Contains("previewExecuted = false", source);
        }

        [Fact]
        public void ColorAndActualScaleAreNativeValuesNotOnlyEchoedRequests()
        {
            var source = Read("Handlers", "LinkCadHandler.cs");
            Assert.Contains("options.ColorMode = (ImportColorMode)Enum.Parse", source);
            Assert.Contains("[\"colorMode\"] = options.ColorMode.ToString()", source);
            Assert.Contains("[\"totalTransformScale\"] = imported.GetTotalTransform().Scale", source);
            Assert.Contains("[\"elementUniqueId\"] = imported.UniqueId", source);
            Assert.Contains("[\"sourceSha256\"] = sourceSha256", source);
            Assert.Contains("FileSha256(full), sourceSha256", source);
            Assert.Contains("Requested CAD import units are unavailable", source);
            Assert.Contains("Requested CAD custom scale is unavailable", source);
            Assert.DoesNotContain("Leave default scale", source);
        }

        [Fact]
        public void HandlerPlansNamedOwnerBeforeSheetCreationAndKeepsLegacyValidationConsistent()
        {
            var handler = Read("Handlers", "LinkCadHandler.cs");
            Assert.Contains("CadLinkOptionPolicy.ShouldCreateDraftingView(targetView != null,", handler);
            var validator = Read("Operator", "OperatorActionSchemaValidator.cs");
            Assert.Contains("link-cad requires viewId, viewName, viewQuery, sheetViewId, or sheetNumber.", validator);
            Assert.DoesNotContain("link-cad requires sheetViewId or sheetNumber.", validator);
        }

        [Fact]
        public void EmbeddedFileIntakeRetainsCadAsBinaryReference()
        {
            var source = Read("Operator", "OperatorPaneControl.cs");
            Assert.Contains("\".dwg\",", source);
            Assert.Contains("if (e == \".dwg\") return \"application/acad\";", source);
        }
    }
}
