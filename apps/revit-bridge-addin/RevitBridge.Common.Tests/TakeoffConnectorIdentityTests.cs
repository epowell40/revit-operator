using System;
using System.IO;
using System.Linq;
using System.Text.Json;
using RevitBridge.Common;
using Xunit;

namespace RevitBridge.Common.Tests
{
    public sealed class TakeoffConnectorIdentityTests
    {
        private sealed class Candidate
        {
            public long Owner { get; }
            public long? NativeId { get; }
            public double Distance { get; }
            public Candidate(long owner, long? nativeId, double distance)
                { Owner = owner; NativeId = nativeId; Distance = distance; }
        }

        private static Candidate Resolve(long? capturedId, double tolerance, params Candidate[] candidates)
            => MepConnectorReacquisition.Resolve(candidates, 42, capturedId,
                connector => connector.Owner, connector => connector.NativeId,
                connector => connector.Distance, tolerance);

        [Fact]
        public void RetainedOmittedIdentityFailuresAndExplicitIdentitySuccessesKeepTheirActualSettlement()
        {
            using var document = JsonDocument.Parse(File.ReadAllText(Path.Combine(AppContext.BaseDirectory,
                "Fixtures", "unit403-takeoff-omitted-identity-rollback.json")));
            var failures = document.RootElement.GetProperty("cases").EnumerateArray().ToList();
            Assert.Equal(4, failures.Count);
            foreach (var row in failures)
            {
                Assert.False(row.GetProperty("request").GetProperty("body").TryGetProperty("branchConnectorId", out _));
                var result = row.GetProperty("result");
                Assert.Equal(0, result.GetProperty("branchConnector").GetProperty("connectorId").GetInt64());
                Assert.Equal("Blocked", result.GetProperty("status").GetString());
                Assert.Contains(result.GetProperty("nativeFailures").EnumerateArray(),
                    failure => failure.GetString() == "The branch connector moved beyond the allowed identity/origin guard.");
                Assert.Equal("none", OperatorAttemptSuccessfulSettlement.Classify(result, "apply", "POST",
                    "/revit/connect-existing-mep-branch").EffectState);
            }
            var successes = document.RootElement.GetProperty("positive_siblings").EnumerateArray().ToList();
            Assert.Equal(3, successes.Count);
            foreach (var row in successes)
            {
                Assert.Equal(0, row.GetProperty("request").GetProperty("body").GetProperty("branchConnectorId").GetInt64());
                var result = row.GetProperty("result");
                Assert.Equal("Connected", result.GetProperty("status").GetString());
                Assert.True(result.GetProperty("connectedAfterCommit").GetBoolean());
                Assert.Equal("applied", OperatorAttemptSuccessfulSettlement.Classify(result, "apply", "POST",
                    "/revit/connect-existing-mep-branch").EffectState);
            }
        }

        [Theory]
        [InlineData(0)]
        [InlineData(7)]
        public void CapturedNativeIdentitySurvivesTrimWithoutSelectingANearbyDifferentConnector(long id)
        {
            // Synthetic geometry neighbor: the live failed receipts do not retain post-trim XYZ.
            var trimmed = new Candidate(42, id, 0.75);
            var coincidentOther = new Candidate(42, id + 1, 0);
            Assert.Same(trimmed, Resolve(id, 0.001, coincidentOther, trimmed));
            Assert.Same(trimmed, Resolve(id, 0.001, trimmed, coincidentOther));
        }

        [Fact]
        public void MissingCapturedIdentityCannotFallBackToCoincidentDifferentConnector()
            => Assert.Throws<InvalidOperationException>(() => Resolve(0, 0.001, new Candidate(42, 1, 0)));

        [Fact]
        public void SameConnectorNumberOnAnotherOwnerCannotSatisfyTheCapturedIdentity()
            => Assert.Throws<InvalidOperationException>(() => Resolve(0, 0.001,
                new Candidate(43, 0, 0), new Candidate(42, 1, 0)));

        [Fact]
        public void AmbiguousNativeIdentityFailsClosed()
            => Assert.Throws<InvalidOperationException>(() => Resolve(0, 0.001,
                new Candidate(42, 0, 0), new Candidate(42, 0, 0.5)));

        [Fact]
        public void IdentityUnavailableUsesGuardedOriginOnlyUnderOriginalOwner()
        {
            var retained = new Candidate(42, null, 0.0005);
            Assert.Same(retained, Resolve(null, 0.001, new Candidate(43, null, 0), retained));
            Assert.Throws<InvalidOperationException>(() => Resolve(null, 0.001, new Candidate(42, null, 0.75)));
            Assert.Throws<InvalidOperationException>(() => Resolve(null, 0.001, new Candidate(43, null, 0)));
        }

        [Theory]
        [InlineData(double.NaN)]
        [InlineData(double.PositiveInfinity)]
        [InlineData(-0.1)]
        public void InvalidFallbackDistanceCannotSelectAConnector(double distance)
            => Assert.Throws<InvalidOperationException>(() => Resolve(null, 0.001, new Candidate(42, null, distance)));

        [Fact]
        public void IdentitySelectionDoesNotMintCommitOrHidePreviewRollbackOrUnknown()
        {
            var candidate = new Candidate(42, 0, 0.75);
            foreach (var nativeStatus in new[] { "Committed", "RolledBack", "Pending" })
            {
                Assert.Same(candidate, Resolve(0, 0.001, candidate));
                var response = new { connectedAfterCommit = true,
                    transaction = OperatorNativeTransactionReceipt.FromObservedStatus(nativeStatus, new[] { 42L, 43L }) };
                Assert.Equal(nativeStatus == "Committed" ? "applied" : nativeStatus == "RolledBack" ? "none" : "unknown",
                    OperatorAttemptSuccessfulSettlement.Classify(response, "apply", "POST", "/revit/connect-existing-mep-branch").EffectState);
            }
        }

        [Fact]
        public void ProductionTakeoffCapturesAndReusesSelectedIdentityBeforeAnyMutation()
        {
            var source = ReadHandlerSource();
            var takeoff = source.Substring(0, source.IndexOf("private static object HandleAirTerminalOnDuct", StringComparison.Ordinal));
            Assert.Contains("var selectedBranchConnectorId = MepSystemUtil.TryGetNativeConnectorId(branchConnector", takeoff);
            Assert.True(takeoff.IndexOf("var selectedBranchConnectorId", StringComparison.Ordinal)
                < takeoff.IndexOf("enterNativeScope();", StringComparison.Ordinal));
            Assert.Equal(3, takeoff.Split(new[] { "ReacquireSelectedTakeoffConnector(" }, StringSplitOptions.None).Length - 1);
            Assert.Contains("=> MepConnectorReacquisition.Resolve(", source);
            Assert.Contains("connector => ElementIdCompat.GetValue(connector.Owner.Id)", source);
            Assert.Contains("restoredBranchConnector.Origin.DistanceTo(branchOrigin) <=", takeoff);
            Assert.Contains("reciprocal physical connection to the committed takeoff", takeoff);
        }

        private static string ReadHandlerSource()
        {
            var retained = Environment.GetEnvironmentVariable("OPERATOR_TEST_TAKEOFF_IDENTITY_SOURCE");
            if (!string.IsNullOrWhiteSpace(retained)) return File.ReadAllText(retained);
            for (var directory = new DirectoryInfo(AppContext.BaseDirectory); directory != null; directory = directory.Parent)
                foreach (var prefix in new[] { "apps/revit-bridge-addin", "revit-bridge-addin" })
                {
                    var file = Path.Combine(directory.FullName, prefix, "RevitBridge.Logic/Handlers/MEP/ConnectExistingMepBranchHandler.cs");
                    if (File.Exists(file)) return File.ReadAllText(file);
                }
            throw new FileNotFoundException("Existing-branch handler source not found.");
        }
    }
}
