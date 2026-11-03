using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text.Json;
using RevitBridge.Common;
using Xunit;

namespace RevitBridge.Common.Tests
{
    public sealed class MepMovePreservationTests
    {
        private static MepMoveEndpointState Endpoint(long id, double x = 1, bool pinned = false) =>
            new MepMoveEndpointState { Id = id, Point = new[] { x, 2d, 3d }, Rotation = 0, Pinned = pinned };
        private static MepMovePortState Port(bool connected = true) =>
            new MepMovePortState { ElementId = 10, ConnectorId = 0, Connected = connected };

        [Fact]
        public void Observed267TerminalDriftFailsEvenWithIntactConnections()
        {
            using var document = JsonDocument.Parse(File.ReadAllText(Path.Combine(AppContext.BaseDirectory,
                "Fixtures", "connected-hvac-move-terminal-drift-267.json")));
            MepMoveEndpointState[] Rows(string name) => document.RootElement.GetProperty(name).EnumerateArray().Select(x =>
                new MepMoveEndpointState { Id = x.GetProperty("id").GetInt64(),
                    Point = x.GetProperty("point").EnumerateArray().Select(n => n.GetDouble()).ToArray(),
                    Rotation = x.GetProperty("rotation").GetDouble() }).ToArray();
            // Matching pin/port states isolate the actual native position failure.
            var result = MepMovePreservation.Evaluate(Rows("before"), Rows("after"), new[] { Port() }, new[] { Port() });
            Assert.True(result.Complete);
            Assert.False(result.Preserved);
            Assert.Equal(new long[] { 1404516, 1405377, 1405877, 1505117 }, result.ChangedEndpointIds);
            Assert.Empty(result.ChangedPortKeys);
        }

        [Fact]
        public void ConnectedAdjustmentWithFixedEndpointsAndRestoredPinsPasses()
        {
            var before = new[] { Endpoint(1), Endpoint(2, pinned: true) };
            var after = new[] { Endpoint(2, pinned: true), Endpoint(1, 1.000000001) };
            Assert.True(MepMovePreservation.Evaluate(before, after, new[] { Port() }, new[] { Port() }).Preserved);
        }

        [Fact]
        public void RotationAndPinRestorationArePartOfPreservation()
        {
            var before = new[] { Endpoint(1) };
            var after = Endpoint(1); after.Rotation = 2 * Math.PI;
            Assert.True(MepMovePreservation.Evaluate(before, new[] { after }, Array.Empty<MepMovePortState>(), Array.Empty<MepMovePortState>()).Preserved);
            after.Rotation = 0.01;
            Assert.False(MepMovePreservation.Evaluate(before, new[] { after }, Array.Empty<MepMovePortState>(), Array.Empty<MepMovePortState>()).Preserved);
            Assert.False(MepMovePreservation.Evaluate(before, new[] { Endpoint(1, pinned: true) }, Array.Empty<MepMovePortState>(), Array.Empty<MepMovePortState>()).Preserved);
        }

        [Theory]
        [InlineData(true, false)]
        [InlineData(false, true)]
        public void UnexpectedPhysicalConnectionChangeFails(bool before, bool after)
        {
            var result = MepMovePreservation.Evaluate(Array.Empty<MepMoveEndpointState>(), Array.Empty<MepMoveEndpointState>(), new[] { Port(before) }, new[] { Port(after) });
            Assert.False(result.Preserved);
            Assert.Equal(new[] { "10:0" }, result.ChangedPortKeys);
        }

        [Fact]
        public void IncompleteDuplicateOrNonfiniteReadsCannotProvePreservation()
        {
            var empty = Array.Empty<MepMovePortState>();
            Assert.False(MepMovePreservation.Evaluate(new[] { Endpoint(1) }, Array.Empty<MepMoveEndpointState>(), empty, empty).Complete);
            Assert.False(MepMovePreservation.Evaluate(new[] { Endpoint(1) }, new[] { Endpoint(1), Endpoint(2) }, empty, empty).Complete);
            Assert.False(MepMovePreservation.Evaluate(new[] { Endpoint(1), Endpoint(1) }, new[] { Endpoint(1) }, empty, empty).Complete);
            Assert.False(MepMovePreservation.Evaluate(new[] { Endpoint(1, double.NaN) }, new[] { Endpoint(1) }, empty, empty).Complete);
            Assert.False(MepMovePreservation.Evaluate(Array.Empty<MepMoveEndpointState>(), Array.Empty<MepMoveEndpointState>(), new[] { Port() }, empty).Complete);
            Assert.False(MepMovePreservation.Evaluate(Array.Empty<MepMoveEndpointState>(), Array.Empty<MepMoveEndpointState>(), new[] { Port(), Port() }, new[] { Port() }).Complete);
        }

        [Fact]
        public void NonMepOrExplicitlySelectedEndpointsHaveNoAdditionalFixedScope()
        {
            Assert.True(MepMovePreservation.Evaluate(Array.Empty<MepMoveEndpointState>(), Array.Empty<MepMoveEndpointState>(), Array.Empty<MepMovePortState>(), Array.Empty<MepMovePortState>()).Preserved);
        }

        [Fact]
        public void FailedPreservationRollsBackWithoutPromotingTransientMoves()
        {
            int commits = 0, rollbacks = 0;
            var nativeStatus = "Started";
            var response = OperatorNativeTransactionExecution.Execute(() => "Started", () => { commits++; return "Committed"; },
                () => { rollbacks++; nativeStatus = "RolledBack"; return nativeStatus; }, () => nativeStatus, () =>
                {
                    var assessment = MepMovePreservation.Evaluate(new[] { Endpoint(1) }, new[] { Endpoint(1, 4) }, new[] { Port() }, new[] { Port() });
                    if (!assessment.Preserved) throw new InvalidOperationException("Fixed HVAC endpoint moved.");
                    return new Dictionary<string, object?>();
                }, () => throw new Exception("Rollback must not produce a committed inventory."));
            Assert.Equal(0, commits); Assert.Equal(1, rollbacks);
            Assert.Equal("none", OperatorAttemptSuccessfulSettlement.Classify(response, "apply", "POST", "/revit/move-elements").EffectState);
        }

        [Fact]
        public void FailedPersistedPreservationKeepsKnownCommitAndRejectsVerification()
        {
            var response = new Dictionary<string, object?> { ["success"] = true,
                ["transaction"] = OperatorNativeTransactionReceipt.Committed(new[] { 10L }) };
            OperatorNativeTransactionExecution.ReadCommitted(response, () => throw new InvalidOperationException("Native fixed endpoint readback changed."));
            Assert.Equal(false, response["verified"]);
            Assert.Equal(false, response["success"]);
            Assert.Equal("applied", OperatorAttemptSuccessfulSettlement.Classify(response, "apply", "POST", "/revit/move-elements").EffectState);
        }
    }
}
