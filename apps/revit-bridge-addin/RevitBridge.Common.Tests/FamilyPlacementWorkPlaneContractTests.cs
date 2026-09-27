using System;
using System.Collections.Generic;
using System.IO;
using System.Text.Json;
using RevitBridge.Common;
using Xunit;

namespace RevitBridge.Common.Tests
{
    public class FamilyPlacementWorkPlaneContractTests
    {
        private static string Root()
        {
            for (var directory = new DirectoryInfo(AppContext.BaseDirectory); directory != null; directory = directory.Parent)
                foreach (var suffix in new[] { "apps/revit-bridge-addin", "revit-bridge-addin" })
                {
                    var root = Path.Combine(directory.FullName, suffix);
                    if (File.Exists(Path.Combine(root, "RevitBridge.Logic/Handlers/PlaceFamiliesHandler.cs"))) return root;
                }
            throw new DirectoryNotFoundException();
        }

        [Fact]
        public void RetainedGroundLevelPlacementCannotDisableAbsoluteCoordinatesByOmittingMode()
        {
            using var fixture = JsonDocument.Parse(File.ReadAllText(Path.Combine(Root(),
                "RevitBridge.Common.Tests/Fixtures/gui-terminal-unhosted-ground-level.json")));
            var apply = fixture.RootElement.GetProperty("apply");
            var request = apply.GetProperty("request").GetProperty("body");
            var instance = request.GetProperty("instances")[0];
            Assert.True(request.GetProperty("allowUnhostedWorkPlanePlacement").GetBoolean());
            Assert.False(instance.TryGetProperty("coordinateMode", out _));
            var actual = apply.GetProperty("result").GetProperty("results")[0];
            Assert.Equal(40.1667, instance.GetProperty("z").GetDouble());
            Assert.True(Math.Abs(actual.GetProperty("locationZ").GetDouble()) < 1e-7);
            Assert.Equal("absolute_model", FamilyPlacementContract.ResolveCoordinateMode(null, true));
            Assert.Throws<InvalidOperationException>(() => FamilyPlacementContract.VerifySupportedPlacement(
                new[] { instance.GetProperty("x").GetDouble(), instance.GetProperty("y").GetDouble(), instance.GetProperty("z").GetDouble() },
                new[] { actual.GetProperty("locationX").GetDouble(), actual.GetProperty("locationY").GetDouble(), actual.GetProperty("locationZ").GetDouble() },
                1362791, 1362791, 20, 20));
        }

        [Theory]
        [InlineData("legacy_level_offset")]
        [InlineData("absolute_modle")]
        public void GeneratedSupportCannotOptOutOfPositionVerification(string mode)
            => Assert.Throws<ArgumentException>(() => FamilyPlacementContract.ResolveCoordinateMode(mode, true));

        [Theory]
        [InlineData(null, "legacy_level_offset")]
        [InlineData("legacy_level_offset", "legacy_level_offset")]
        [InlineData("absolute_model", "absolute_model")]
        public void OrdinaryDocumentedCallersKeepTheirCoordinateMode(string? mode, string expected)
            => Assert.Equal(expected, FamilyPlacementContract.ResolveCoordinateMode(mode, false));

        [Fact]
        public void NativeHandlerUsesReferenceHostAndFinalProofInsideInstanceRollbackBoundary()
        {
            var source = File.ReadAllText(Path.Combine(Root(), "RevitBridge.Logic/Handlers/PlaceFamiliesHandler.cs"));
            Assert.Contains("CreateHorizontalSupportPlane(doc", source);
            Assert.Contains("FamilyPlacementContract.VerifySupportedPlacement", source);
            Assert.True(source.IndexOf("CreateHorizontalSupportPlane(doc", StringComparison.Ordinal) > source.IndexOf("instanceScope.Start()", StringComparison.Ordinal));
            var parameters = source.IndexOf("ApplyRequestedParameters(doc, fi, instData.parameters, instResult, apply: true)", StringComparison.Ordinal);
            Assert.True(parameters >= 0);
            Assert.True(source.IndexOf("FamilyPlacementContract.VerifySupportedPlacement", StringComparison.Ordinal) > parameters);
            Assert.Contains("instanceScope.RollBack() != TransactionStatus.RolledBack", source);
            Assert.Contains("result.elementIds.Concat(result.supportPlaneElementIds)", source);
            Assert.Contains("result.supportPlaneElementIds.Clear()", source);
            Assert.Contains("app.Application.DocumentChanged -= Changed", source);
            Assert.True(source.IndexOf("NativeNonInteractiveFailureHandling.Configure(t, failureGuard)", StringComparison.Ordinal)
                > source.IndexOf("t.Start()", StringComparison.Ordinal));
            Assert.Contains("result.capturedFailures = failureGuard.Failures", source);
            Assert.Contains("result.failureRollbackRequested = failureGuard.RollbackRequested", source);
            Assert.Contains("doc.Create.NewFamilyInstance(face.Reference, face.Point, face.Direction, symbol)", source);
            Assert.Contains("if (fi == null && generatedWorkPlane)", source);
            // Both summary and placement must read schedule/reference levels when Element.LevelId is invalid.
            Assert.Contains("result.levelId = HostedPlacementUtil.ReadInstanceLevelId(instance)", source);
            var summary = File.ReadAllText(Path.Combine(Root(), "RevitBridge.Logic/Handlers/GetElementSummaryHandler.cs"));
            Assert.Contains("effectiveLevelId = HostedPlacementUtil.ReadInstanceLevelId(elem)", summary);
        }

        [Theory]
        [InlineData(0, 1362791, 20)]
        [InlineData(40.1667, 1362792, 20)]
        [InlineData(40.1667, 1362791, 21)]
        public void FinalNativeProofRejectsParameterInducedPositionLevelOrHostChange(double z, long level, long host)
            => Assert.Throws<InvalidOperationException>(() => FamilyPlacementContract.VerifySupportedPlacement(
                new[] { -33.55, 14.1, 40.1667 }, new[] { -33.55, 14.1, z }, 1362791, level, 20, host));

        [Fact]
        public void ExactSupportPlacementPassesWithoutInventingOrientationOrArchitecturalHosting()
        {
            var point = new[] { -33.55, 14.1, 40.1667 };
            FamilyPlacementContract.VerifySupportedPlacement(point, point, 1362791, 1362791, 20, 20);
            Assert.Throws<InvalidOperationException>(() => FamilyPlacementContract.VerifySupportedPlacement(point, point, 1362791, null, 20, 20));
            Assert.Throws<InvalidOperationException>(() => FamilyPlacementContract.VerifySupportedPlacement(point, point, 1362791, 1362791, 20, null));
            Assert.Throws<ArgumentException>(() => FamilyPlacementContract.VerifySupportedPlacement(point, new[] { 0.0, 0.0, double.NaN }, 1362791, 1362791, 20, 20));
        }

        [Fact]
        public void ReflectedSchemaAdvertisesSameModesUnitsAndProvisionalSupportSemantics()
        {
            var fields = new Dictionary<string, object>();
            foreach (var axis in new[] { "x", "y", "z" }) fields[axis] = new Dictionary<string, object> { ["type"] = "number" };
            var schema = new Dictionary<string, object> { ["properties"] = new Dictionary<string, object> {
                ["instances"] = new Dictionary<string, object> { ["type"] = "array", ["items"] = new Dictionary<string, object> { ["properties"] = fields } },
                ["allowUnhostedWorkPlanePlacement"] = new Dictionary<string, object> { ["type"] = "boolean" }
            } };
            FamilyPlacementContract.ApplyRequestSchema(schema);
            using var json = JsonDocument.Parse(JsonSerializer.Serialize(schema));
            var props = json.RootElement.GetProperty("properties");
            var mode = props.GetProperty("instances").GetProperty("items").GetProperty("properties").GetProperty("coordinateMode");
            Assert.Equal("absolute_model", mode.GetProperty("oneOf")[1].GetProperty("enum")[0].GetString());
            Assert.Equal("legacy_level_offset", mode.GetProperty("oneOf")[1].GetProperty("enum")[1].GetString());
            Assert.Contains("not an architectural ceiling", props.GetProperty("allowUnhostedWorkPlanePlacement").GetProperty("description").GetString());
            Assert.Contains("ordinary", mode.GetProperty("description").GetString());
            var nativeSchema = File.ReadAllText(Path.Combine(Root(), "RevitBridge/Operator/OperatorToolIntrospection.cs"));
            Assert.Contains("FamilyPlacementContract.ApplyRequestSchema(schema)", nativeSchema);
        }

        [Fact]
        public void NativeCommitReportsInstanceAndSupportButPreviewCannotMintCreatedIds()
        {
            var committed = OperatorNativeTransactionReceipt.FromObservedStatus("Committed", Array.Empty<long>())
                .WithNativeCreatedElements(new[] { 20L, 21L });
            Assert.Equal(new[] { 20L, 21L }, committed.AddedElementIds);
            Assert.Equal(new[] { 20L, 21L }, committed.AffectedElementIds);
            var preview = OperatorNativeTransactionReceipt.FromObservedStatus("RolledBack", Array.Empty<long>());
            Assert.Empty(preview.AddedElementIds);
            Assert.Throws<InvalidOperationException>(() => preview.WithNativeCreatedElements(new[] { 20L, 21L }));
        }
    }
}
