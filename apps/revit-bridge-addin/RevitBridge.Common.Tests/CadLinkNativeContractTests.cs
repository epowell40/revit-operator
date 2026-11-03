using System;
using System.IO;
using System.Linq;
using Xunit;

namespace RevitBridge.Common.Tests
{
    public sealed class CadLinkNativeContractTests
    {
        [Fact]
        public void NativeCadUsesValidatedFormatAndKeepsSourceDirectionCorrectionExplicit()
        {
            var source = Read("Handlers", "LinkCadHandler.cs");
            Assert.Contains("CadLinkOptionPolicy.SourceFormat(full)", source);
            Assert.Contains("options.AutoCorrectAlmostVHLines = p.autoCorrectAlmostVHLines ?? false", source);
            var sourceHash = source.IndexOf("CadLinkOptionPolicy.RequireExpectedSourceHash(p.expectedSourceSha256, sourceSha256)", StringComparison.Ordinal);
            Assert.True(sourceHash >= 0 && sourceHash < source.IndexOf("NativeSingleTransaction.Execute", StringComparison.Ordinal));
            Assert.Contains("NativeMutationPreflightBoundary.Execute", source);
            var nativeEntry = source.IndexOf("enterNativeScope();", StringComparison.Ordinal);
            Assert.True(sourceHash < nativeEntry && nativeEntry < source.IndexOf("NativeSingleTransaction.Execute", StringComparison.Ordinal));
            Assert.Contains("FileSha256(full), sourceSha256", source);
            Assert.Contains("[\"autoCorrectAlmostVHLines\"] = options.AutoCorrectAlmostVHLines", source);
            Assert.Contains("[\"sourceFormat\"] = sourceFormat", source);
        }

        [Fact]
        public void CadReadbackIsOptInBoundedAndNeverExplodesOrEditsImports()
        {
            var logic = Read("..", "RevitBridge.Logic", "NativeCadGeometry.cs");
            Assert.Contains("transform.Multiply(instance.Transform)", logic);
            Assert.Contains("curve.CreateTransformed(transform)", logic);
            Assert.Contains("NativeDraftingCurveGeometry.Read(transformed)", logic);
            Assert.Contains("layerName = LayerName(view.Document, item)", logic);
            Assert.Contains("GraphicsStyleCategory?.Name", logic);
            Assert.Contains("budget.TryConsume(points.Count)", logic);
            Assert.Contains("budget.TryConsume(cost)", logic);
            Assert.Contains("complete = issues.Count == 0 && items.Count > 0", logic);
            Assert.DoesNotContain("Transaction(", logic);
            Assert.DoesNotContain("Explode", logic);
            var handler = Read("..", "RevitBridge.Logic", "Handlers", "ViewOwnedDetailingHandler.cs");
            Assert.Contains("request.includeCadGeometry == true ? new CadGeometryReadBudget", handler);
            Assert.Contains("ReadView(doc, view, limit, cadBudget, request.cadElementId, request.cadGeometryOffset)", handler);
            Assert.Contains("cadGeometryComplete && unreadableIds.Count == 0", handler);
        }

        [Fact]
        public void CadPagesKeepWholeCoverageSeparateAndHashEveryNativePrimitiveAgainstExactOwner()
        {
            var logic = Read("..", "RevitBridge.Logic", "NativeCadGeometry.cs");
            Assert.Contains("imported.OwnerViewId != view.Id", logic);
            Assert.Contains("bool include = page.Observe(cost)", logic);
            Assert.Contains("Hash(record);", logic);
            Assert.Contains("if (include) items.Add(record)", logic);
            Assert.Contains("complete = completePage && offset == 0 && !page.NextOffset.HasValue", logic);
            Assert.Contains("completeGeometrySnapshotSha256 = completePage", logic);
            Assert.Contains("stream.FlushFinalBlock()", logic);
            var handler = Read("..", "RevitBridge.Logic", "Handlers", "ViewOwnedDetailingHandler.cs");
            Assert.Contains("request.cadGeometryOffset > CadGeometryPageWindow.MaximumPrimitives", handler);
            Assert.Contains("target.OwnerViewId) != ids[0]", handler);
            Assert.Contains("NativeCadGeometry.ReadPage(imported, view, cadBudget, cadOffset.Value)", handler);
        }

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
