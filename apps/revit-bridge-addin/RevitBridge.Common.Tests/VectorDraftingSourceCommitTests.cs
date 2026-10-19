using System;
using System.IO;
using Xunit;
namespace RevitBridge.Common.Tests
{
    public sealed class VectorDraftingSourceCommitTests
    {
        private static string Read(string relative)
        {
            for (var dir = new DirectoryInfo(AppContext.BaseDirectory); dir != null; dir = dir.Parent)
                foreach (var prefix in new[] { "apps/revit-bridge-addin", "revit-bridge-addin" })
                {
                    var path = Path.Combine(dir.FullName, prefix, relative);
                    if (File.Exists(path)) return File.ReadAllText(path);
                }
            throw new FileNotFoundException(relative);
        }
        [Fact]
        public void JoinedCurveRestorationRemainsInsideOwnedTransactionAndBeforeSourceAdmission()
        {
            var renderer = Read("RevitBridge.Logic/VectorDraftingNativeRenderer.cs");
            Assert.Contains("item.native.SetGeometryCurve(source, true)", renderer);
            Assert.True(renderer.IndexOf("sourceCurves.Add", StringComparison.Ordinal) < renderer.IndexOf("foreach (var item in sourceCurves)", StringComparison.Ordinal));
            var handler = Read("RevitBridge/Handlers/ImportVectorDetailHandler.cs");
            int render = handler.IndexOf(".Render(plan, request.partIndex)", StringComparison.Ordinal);
            int unchanged = handler.IndexOf("VectorDraftingImportState.CurrentSnapshot(doc, stored)", render, StringComparison.Ordinal);
            int check = handler.IndexOf("VectorDraftingNativeProjection.RequireMatchBeforeCommit", StringComparison.Ordinal);
            Assert.True(render < unchanged && unchanged < check);
            Assert.True(check < handler.IndexOf("VectorDraftingImportState.Store", StringComparison.Ordinal));
            Assert.True(check < handler.IndexOf("OperatorNativeTransactionExecution.ReadCommitted", StringComparison.Ordinal));
        }
        [Fact]
        public void CompleteSourceComparisonAndCommittedSnapshotCannotBeReplacedByEndpointToleranceOrResealing()
        {
            var source = Read("RevitBridge.Logic/VectorDraftingNativeProjection.cs");
            Assert.Contains("JsonSerializer.Serialize(Check(doc, state, part))", source);
            Assert.Contains("GetProperty(\"completePartRead\").GetBoolean()", source);
            Assert.Contains("GetProperty(\"sourceNativeProjectionMatches\").GetBoolean()", source);
            Assert.Contains("CurveKey(projected) != CurveKey(detail.GeometryCurve)", source);
            Assert.Contains("Complete native fill boundaries/holes differ.", source);
            var state = Read("RevitBridge.Logic/VectorDraftingImportState.cs");
            Assert.Contains("PartSnapshot(doc, state, part) != part.NativeSnapshotSha256", state);
            Assert.Contains("Math.Round(n, 9)", state);
        }
    }
}
