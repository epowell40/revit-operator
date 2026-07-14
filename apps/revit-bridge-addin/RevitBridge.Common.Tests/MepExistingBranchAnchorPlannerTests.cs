using System.Collections.Generic;
using RevitBridge.Common;
using Xunit;

namespace RevitBridge.Common.Tests
{
    public class MepExistingBranchAnchorPlannerTests
    {
        [Fact]
        public void ReusesReducerWhenMainAndBranchSidesAreUnambiguous()
        {
            var plan = MepExistingBranchAnchorPlanner.Plan(
                new List<MepBranchAnchorConnector>
                {
                    Connector(0, 45, 4.8567708333, 1.0 / 12.0),
                    Connector(1, 45, 4.890625, 1.5 / 12.0)
                },
                Point(45, 5),
                Point(45, 0),
                RoundSize(1.5 / 12.0),
                RoundSize(1.0 / 12.0));

            Assert.True(plan.ApplySupported);
            Assert.Equal(1, plan.MainConnectorIndex);
            Assert.Equal(0, plan.BranchConnectorIndex);
        }

        [Fact]
        public void RejectsAlreadyConnectedOrExtraAnchorConnectors()
        {
            var connectors = new List<MepBranchAnchorConnector>
            {
                Connector(0, 45, 4.856, 1.0 / 12.0),
                Connector(1, 45, 4.890, 1.5 / 12.0),
                Connector(2, 45, 4.875, 1.5 / 12.0)
            };

            var plan = MepExistingBranchAnchorPlanner.Plan(connectors, Point(45, 5), Point(45, 0), RoundSize(1.5 / 12.0), RoundSize(1.0 / 12.0));

            Assert.False(plan.ApplySupported);
            Assert.Equal("anchor_connector_count", plan.BlockCode);
        }

        [Fact]
        public void RejectsWrongBranchSizeAndReversedOrientation()
        {
            var wrongSize = MepExistingBranchAnchorPlanner.Plan(
                new[] { Connector(0, 45, 4.856, 0.75 / 12.0), Connector(1, 45, 4.890, 1.5 / 12.0) },
                Point(45, 5), Point(45, 0), RoundSize(1.5 / 12.0), RoundSize(1.0 / 12.0));
            Assert.False(wrongSize.ApplySupported);
            Assert.Equal("anchor_branch_size_mismatch", wrongSize.BlockCode);

            var reversed = MepExistingBranchAnchorPlanner.Plan(
                new[] { Connector(0, 45, 4.95, 1.0 / 12.0), Connector(1, 45, 5.05, 1.5 / 12.0) },
                Point(45, 5), Point(45, 10), RoundSize(1.5 / 12.0), RoundSize(1.0 / 12.0));
            Assert.False(reversed.ApplySupported);
            Assert.Equal("anchor_orientation_ambiguous", reversed.BlockCode);
        }

        [Theory]
        [InlineData("tee", true)]
        [InlineData("TEE", true)]
        [InlineData("tap", false)]
        [InlineData("auto", false)]
        [InlineData("", false)]
        public void RetainedAnchorRequiresNormalizedTeeMode(string mode, bool expected)
        {
            Assert.Equal(expected, MepExistingBranchAnchorPlanner.SupportsConnectionMode(mode));
        }

        private static MepBranchAnchorConnector Connector(int index, double x, double y, double diameterFt) => new MepBranchAnchorConnector
        {
            Index = index,
            Origin = Point(x, y),
            Size = RoundSize(diameterFt)
        };

        private static MepBranchAnchorPoint Point(double x, double y, double z = 44.5) => new MepBranchAnchorPoint { X = x, Y = y, Z = z };
        private static MepBranchAnchorSize RoundSize(double diameterFt) => new MepBranchAnchorSize { Domain = "piping", Shape = "round", DiameterFt = diameterFt };
    }
}
