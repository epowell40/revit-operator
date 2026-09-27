using System;
using System.IO;
using System.Text.Json;
using RevitBridge.Common;
using RevitBridge.Logic.Handlers;
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
        private static string Source() => File.ReadAllText(Environment.GetEnvironmentVariable("OPERATOR_PLACEMENT_HANDLER_SOURCE_FOR_TEST")
            ?? Path.Combine(Root(), "RevitBridge.Logic/Handlers/PlaceFamiliesHandler.cs"));
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
            var parameters = source.IndexOf("ApplyRequestedParameters(doc, fi, instData.parameters, instResult, apply: true)", StringComparison.Ordinal);
            Assert.True(parameters >= 0);
            Assert.True(source.IndexOf("instResult.levelVerified = instResult.levelId ==", StringComparison.Ordinal) > parameters);
            Assert.Contains("using var instanceScope = new SubTransaction(doc)", source);
            Assert.Contains("instanceScope.RollBack() != TransactionStatus.RolledBack", source);
        }

        [Theory]
        [InlineData("0.3333333333333333", 0.3333333333333333)]
        [InlineData("0.25", 0.25)]
        [InlineData("1,234", 1234.0)]
        [InlineData("2.5e-1", 0.25)]
        public void BareNumericParametersRemainInvariantInternalUnits(string text, double expected)
            => Assert.Equal(expected, PlacementParameterValues.ParseDouble(text, _ => throw new Exception("Numeric value must not use display units.")));

        [Theory]
        [InlineData("4\"", 0.3333333333333333)]
        [InlineData("3\"", 0.25)]
        [InlineData("0'-4\"", 0.3333333333333333)]
        [InlineData("101.6 mm", 0.3333333333333333)]
        public void FormattedValuesRequireAnExplicitNativeUnitInterpretation(string text, double interpreted)
        {
            var calls = 0;
            var actual = PlacementParameterValues.ParseDouble(text, received => { Assert.Equal(text, received); calls++; return interpreted; });
            Assert.Equal(1, calls);
            Assert.True(PlacementParameterValues.MatchesDouble(actual, interpreted));
            Assert.False(PlacementParameterValues.MatchesDouble(0.5, actual)); // Retained default radius must not verify.
        }

        [Theory]
        [InlineData("NaN")]
        [InlineData("Infinity")]
        [InlineData("1e999")]
        [InlineData("unparseable")]
        [InlineData("4 square feet")]
        public void UnparseableOrNonfiniteRequestedValuesFailExplicitly(string text)
            => Assert.Throws<FormatException>(() => PlacementParameterValues.ParseDouble(text, _ => null));

        [Fact]
        public void InvalidNativeInterpretationOrReadbackCannotVerify()
        {
            Assert.Throws<FormatException>(() => PlacementParameterValues.ParseDouble("4\"", _ => double.NaN));
            Assert.Throws<FormatException>(() => PlacementParameterValues.ParseDouble("4\"", _ => double.PositiveInfinity));
            Assert.False(PlacementParameterValues.MatchesDouble(double.NaN, 0.25));
            Assert.False(PlacementParameterValues.MatchesDouble(0.25, double.NaN));
            Assert.False(PlacementParameterValues.MatchesDouble(double.PositiveInfinity, double.PositiveInfinity));
            Assert.False(PlacementParameterValues.MatchesDouble(0.25000001, 0.25));
        }

        [Theory]
        [InlineData("Placed", 0, 0, true)]
        [InlineData("Planned", 0, 0, true)]
        [InlineData("Unknown", 0, 0, false)]
        [InlineData("Failed", 0, 0, false)]
        [InlineData("PlacedWithErrors", 1, 0, false)]
        [InlineData("PlannedWithErrors", 1, 0, false)]
        [InlineData("Placed", 0, 1, false)]
        [InlineData("Placed", 1, 0, false)]
        public void OverallSuccessRequiresCompleteIntentButNotNewlyCreatedCount(string status, int failed, int verificationFailed, bool expected)
            => Assert.Equal(expected, PlacementParameterValues.ResultSucceeded(status, failed, verificationFailed));

        [Fact]
        public void RequestedParametersAreVerifiedWithinInstanceRollbackAndAfterOuterCommit()
        {
            var source = Source();
            var apply = source.IndexOf("ApplyRequestedParameters(doc, fi, instData.parameters, instResult, apply: true)", StringComparison.Ordinal);
            Assert.True(apply > source.IndexOf("instanceScope.Start()", StringComparison.Ordinal));
            var regenerate = source.IndexOf("doc.Regenerate();", apply, StringComparison.Ordinal);
            var verify = source.IndexOf("VerifyRequestedParameters(fi, parameterExpectations, instResult, afterCommit: false)", StringComparison.Ordinal);
            Assert.True(verify > regenerate);
            Assert.True(source.IndexOf("if (instanceScope.Commit() != TransactionStatus.Committed)", verify, StringComparison.Ordinal) > verify);
            Assert.Contains("instanceScope.RollBack() != TransactionStatus.RolledBack", source);
            Assert.Contains("if (!bestEffort)", source);
            Assert.Contains("ApplyRequestedParameters(doc, existing, instData.parameters, instResult, apply: false)", source);
            Assert.Contains("Parameter identity or storage type changed.", source);
            Assert.Contains("Parameter is read-only.", source);
            Assert.Contains("Requested parameter was not found.", source);
            Assert.Contains("Requested parameter name is ambiguous.", source);
            Assert.Contains("Unsupported parameter storage type.", source);
            Assert.Contains("Set returned false", source);
            var committed = source.IndexOf("if (observed != TransactionStatus.Committed)", StringComparison.Ordinal);
            Assert.True(source.IndexOf("var committedElement = doc.GetElement(ToElementId(target.id))", StringComparison.Ordinal) > committed);
            Assert.Contains("VerifyRequestedParameters(committedElement, target.expectations, target.result, afterCommit: true)", source);
            Assert.Contains("public bool success => PlacementParameterValues.ResultSucceeded", source);
            Assert.Contains("SetParameter(fi, \"ROS_AutoGenerated\", \"1\")", source);
        }

        [Theory]
        [InlineData("Committed", "applied")]
        [InlineData("RolledBack", "none")]
        [InlineData("Pending", "unknown")]
        public void ParameterFailureCannotEraseCommittedOrUncertainEffects(string status, string effect)
        {
            var receipt = OperatorNativeTransactionReceipt.FromObservedStatus(status, new[] { 201L, 202L });
            var result = new { status = "PlacedWithErrors", success = false, placedCount = status == "Committed" ? 1 : 0,
                failedCount = 1, parameterVerificationFailedCount = 0, transaction = receipt };
            var actual = OperatorAttemptSuccessfulSettlement.Classify(result, "apply", "POST", "/revit/place-families");
            Assert.Equal(effect, actual.EffectState);
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
