using System;
using System.IO;
using System.Text.Json;
using RevitBridge.Common;
using Xunit;

namespace RevitBridge.Common.Tests
{
    public class FamilyPlacementRecoveryTests
    {
        private static string Root()
        {
            for (var directory = new DirectoryInfo(AppContext.BaseDirectory); directory != null; directory = directory.Parent)
            {
                foreach (var suffix in new[] { "apps/revit-bridge-addin", "revit-bridge-addin" })
                {
                    var root = Path.Combine(directory.FullName, suffix);
                    if (File.Exists(Path.Combine(root, "RevitBridge.Logic/Handlers/PlaceFamiliesHandler.cs"))) return root;
                }
            }
            throw new DirectoryNotFoundException();
        }
        private static string Source() => File.ReadAllText(Path.Combine(Root(), "RevitBridge.Logic/Handlers/PlaceFamiliesHandler.cs"));
        private static JsonDocument Replay() => JsonDocument.Parse(File.ReadAllText(Path.Combine(Root(), "../mcp-server/src/lib/fixtures/c46-linked-face-placement.json")));

        [Fact]
        public void IncompleteLinkedHostCannotBecomeValidThroughAnExistingMatch()
        {
            using var replay = Replay();
            var failed = replay.RootElement.GetProperty("cases").GetProperty("missing-linked-host");
            Assert.Equal("skipped", failed.GetProperty("result").GetProperty("results")[0].GetProperty("status").GetString());
            Assert.False(failed.GetProperty("request").GetProperty("instances")[0].TryGetProperty("linkedHostElementId", out _));
            Assert.Throws<ArgumentException>(() => LinkedHostPlacementPolicy.Validate(true, true, null));
            var source = Source();
            Assert.True(source.IndexOf("LinkedHostPlacementPolicy.Validate(resolvedHost", StringComparison.Ordinal) < source.IndexOf("var match = FindEquivalent", StringComparison.Ordinal));
        }

        [Fact]
        public void DeduplicationUsesTheSameProjectedFacePointAsCreation()
        {
            using var replay = Replay();
            var cases = replay.RootElement.GetProperty("cases");
            var actual = cases.GetProperty("apply").GetProperty("result").GetProperty("results")[0];
            var repeat = cases.GetProperty("projected-repeat");
            Assert.Equal("planned", repeat.GetProperty("result").GetProperty("results")[0].GetProperty("status").GetString());
            Assert.Equal(actual.GetProperty("locationZ").GetDouble(), repeat.GetProperty("result").GetProperty("results")[0].GetProperty("locationZ").GetDouble());
            Assert.True(Math.Abs(actual.GetProperty("locationZ").GetDouble() - repeat.GetProperty("request").GetProperty("instances")[0].GetProperty("z").GetDouble()) > 0.49);
            var source = Source();
            Assert.True(source.IndexOf("idempotencyPoint = resolvedFace.Point;", StringComparison.Ordinal) < source.IndexOf("var match = FindEquivalent", StringComparison.Ordinal));
            Assert.Contains("PlaceOnResolvedHostFace(doc, resolvedFace!, symbol)", source);
            Assert.Contains("doc.Create.NewFamilyInstance(face.Reference, face.Point, face.Direction, symbol)", source);
            Assert.Contains("plannedOrCreatedPoints.Add((idempotencyPoint", source);
        }

        [Fact]
        public void RequestedLevelIsAssignedAndIndependentlyRecheckedAfterParameters()
        {
            using var replay = Replay();
            Assert.Equal("-1", replay.RootElement.GetProperty("independent_readback")[1].GetProperty("result")[0].GetProperty("parameters").GetProperty("Schedule Level").GetString());
            var source = Source();
            Assert.Contains("HostedPlacementUtil.ApplyResolvedLevelToFaceHostedInstance(fi, instanceLevel!", source);
            Assert.Contains("HostedPlacementUtil.ReadInstanceLevelId(existing) != ElementIdCompat.GetValue(instanceLevel!.Id)", source);
            Assert.True(source.IndexOf("instResult.levelVerified = instResult.levelId ==", StringComparison.Ordinal) > source.IndexOf("SetParameter(fi, kvp.Key, kvp.Value)", StringComparison.Ordinal));
            Assert.Contains("using var instanceScope = new SubTransaction(doc)", source);
            Assert.Contains("instanceScope.RollBack() != TransactionStatus.RolledBack", source);
        }

        [Theory]
        [InlineData("Committed", "applied")]
        [InlineData("RolledBack", "none")]
        [InlineData("Pending", "unknown")]
        [InlineData("Error", "unknown")]
        public void PlacementSettlementUsesObservedTransactionStatus(string status, string expected)
        {
            using var replay = Replay();
            var old = replay.RootElement.GetProperty("cases").GetProperty("apply").GetProperty("result");
            Assert.Equal("unknown", OperatorAttemptSuccessfulSettlement.Classify(old, "apply", "POST", "/revit/place-families").EffectState);
            var result = new { status = "Placed", placedCount = 1, elementIds = new[] { 1542920L }, transaction = OperatorNativeTransactionReceipt.FromObservedStatus(status, new[] { 1542920L }) };
            Assert.Equal(expected, OperatorAttemptSuccessfulSettlement.Classify(result, "apply", "POST", "/revit/place-families").EffectState);
            var source = Source();
            Assert.Contains("var observed = t.Commit();", source);
            Assert.Contains("var observed = t.RollBack();", source);
            Assert.Contains("OperatorNativeTransactionReceipt.FromObservedStatus(observed.ToString(), result.elementIds)", source);
            Assert.Contains("result.elementIds.Clear();", source);
        }
    }
}
