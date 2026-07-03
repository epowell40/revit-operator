using RevitBridge.Common;
using Xunit;

namespace RevitBridge.Common.Tests
{
    public class MepRouteReroutePlannerTests
    {
        [Fact]
        public void PlanOffsetRerouteUsesNormalizedSplitPositions()
        {
            var plan = MepRouteReroutePlanner.PlanOffsetReroute(
                new BranchPoint3d(0, 0, 10),
                new BranchPoint3d(20, 0, 10),
                split1ChainageFt: null,
                split2ChainageFt: null,
                split1Normalized: 0.25,
                split2Normalized: 0.75,
                offsetVector: new BranchPoint3d(0, 0, -2));

            Assert.True(plan.ApplySupported);
            Assert.Equal(5, plan.Split1ChainageFt, 6);
            Assert.Equal(15, plan.Split2ChainageFt, 6);
            Assert.Equal(5, plan.Segments.Count);
            Assert.Equal(4, plan.ExpectedFittings.Count);
            Assert.Equal(8, plan.OffsetSplit1.Z, 6);
            Assert.Equal(8, plan.OffsetSplit2.Z, 6);
            Assert.All(plan.ExpectedFittings, fitting => Assert.Equal("elbow", fitting.ExpectedFitting));
        }

        [Fact]
        public void PlanOffsetRerouteSortsChainages()
        {
            var plan = MepRouteReroutePlanner.PlanOffsetReroute(
                new BranchPoint3d(0, 0, 0),
                new BranchPoint3d(20, 0, 0),
                split1ChainageFt: 14,
                split2ChainageFt: 6,
                split1Normalized: null,
                split2Normalized: null,
                offsetVector: new BranchPoint3d(0, 2, 0));

            Assert.True(plan.ApplySupported);
            Assert.Equal(6, plan.Split1ChainageFt, 6);
            Assert.Equal(14, plan.Split2ChainageFt, 6);
        }

        [Fact]
        public void PlanOffsetRerouteBlocksNearEndpointSplit()
        {
            var plan = MepRouteReroutePlanner.PlanOffsetReroute(
                new BranchPoint3d(0, 0, 0),
                new BranchPoint3d(20, 0, 0),
                split1ChainageFt: 0.25,
                split2ChainageFt: 10,
                split1Normalized: null,
                split2Normalized: null,
                offsetVector: new BranchPoint3d(0, 2, 0));

            Assert.False(plan.ApplySupported);
            Assert.Equal("split_too_close_to_endpoint", plan.BlockCode);
        }

        [Fact]
        public void PlanOffsetRerouteBlocksTooSmallOffset()
        {
            var plan = MepRouteReroutePlanner.PlanOffsetReroute(
                new BranchPoint3d(0, 0, 0),
                new BranchPoint3d(20, 0, 0),
                split1ChainageFt: 5,
                split2ChainageFt: 12,
                split1Normalized: null,
                split2Normalized: null,
                offsetVector: new BranchPoint3d(0, 0.01, 0));

            Assert.False(plan.ApplySupported);
            Assert.Equal("offset_too_small", plan.BlockCode);
        }

        [Fact]
        public void PlanSizeTransitionUsesNormalizedChainage()
        {
            var plan = MepRouteReroutePlanner.PlanSizeTransition(
                new BranchPoint3d(0, 0, 10),
                new BranchPoint3d(20, 0, 10),
                transitionChainageFt: null,
                transitionNormalized: 0.4);

            Assert.True(plan.ApplySupported);
            Assert.Equal(8, plan.TransitionChainageFt, 6);
            Assert.Equal(8, plan.TransitionPoint.X, 6);
            Assert.Equal(2, plan.Segments.Count);
            Assert.Equal("upstream", plan.Segments[0].Role);
            Assert.Equal("downstream", plan.Segments[1].Role);
            Assert.Equal("transition", plan.ExpectedFitting.ExpectedFitting);
        }

        [Fact]
        public void PlanSizeTransitionBlocksNearEndpoint()
        {
            var plan = MepRouteReroutePlanner.PlanSizeTransition(
                new BranchPoint3d(0, 0, 0),
                new BranchPoint3d(20, 0, 0),
                transitionChainageFt: 0.25,
                transitionNormalized: null);

            Assert.False(plan.ApplySupported);
            Assert.Equal("transition_too_close_to_endpoint", plan.BlockCode);
        }
    }
}
