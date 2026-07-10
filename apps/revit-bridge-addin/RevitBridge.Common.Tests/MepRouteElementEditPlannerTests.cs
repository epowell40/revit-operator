using System;
using RevitBridge.Common;
using Xunit;

namespace RevitBridge.Common.Tests
{
    public class MepRouteElementEditPlannerTests
    {
        [Fact]
        public void PlanElevationMoveUsesExplicitDelta()
        {
            var plans = MepRouteElementEditPlanner.PlanElevationMove(new[]
            {
                new MepRouteElementEditPlanner.CurveInput
                {
                    ElementId = 10,
                    StartXyz = new[] { 1.0, 2.0, 9.0 },
                    EndXyz = new[] { 5.0, 2.0, 9.0 }
                }
            }, deltaZFt: -1.25, targetCenterlineZFt: null);

            var plan = Assert.Single(plans);
            Assert.Equal(10, plan.ElementId);
            Assert.Equal(-1.25, plan.DeltaZFt, 6);
            Assert.Equal(7.75, plan.AfterStartXyz[2], 6);
            Assert.Equal(7.75, plan.AfterEndXyz[2], 6);
        }

        [Fact]
        public void PlanElevationMoveUsesTargetCenterlineZ()
        {
            var plans = MepRouteElementEditPlanner.PlanElevationMove(new[]
            {
                new MepRouteElementEditPlanner.CurveInput
                {
                    ElementId = 11,
                    StartXyz = new[] { 0.0, 0.0, 10.0 },
                    EndXyz = new[] { 4.0, 0.0, 10.0 }
                }
            }, deltaZFt: null, targetCenterlineZFt: 8.5);

            var plan = Assert.Single(plans);
            Assert.Equal(-1.5, plan.DeltaZFt, 6);
            Assert.Equal(8.5, plan.AfterStartXyz[2], 6);
            Assert.Equal(8.5, plan.AfterEndXyz[2], 6);
        }

        [Fact]
        public void PlanElevationMoveBlocksSlopedCurve()
        {
            var ex = Assert.Throws<InvalidOperationException>(() =>
                MepRouteElementEditPlanner.PlanElevationMove(new[]
                {
                    new MepRouteElementEditPlanner.CurveInput
                    {
                        ElementId = 12,
                        StartXyz = new[] { 0.0, 0.0, 10.0 },
                        EndXyz = new[] { 4.0, 0.0, 10.5 }
                    }
                }, deltaZFt: -1.0, targetCenterlineZFt: null));

            Assert.Contains("sloped", ex.Message, StringComparison.OrdinalIgnoreCase);
        }

        [Fact]
        public void PlanElevationMoveBlocksConflictingElevationInputs()
        {
            Assert.Throws<ArgumentException>(() =>
                MepRouteElementEditPlanner.PlanElevationMove(Array.Empty<MepRouteElementEditPlanner.CurveInput>(), deltaZFt: -1.0, targetCenterlineZFt: 8.0));
        }
    }
}
