using System.Collections.Generic;
using RevitBridge.Common;
using Xunit;

namespace RevitBridge.Common.Tests
{
    public class MepBranchSplitPlannerTests
    {
        [Fact]
        public void DuctLineSplitPlanSupportsSafeProjectedMidpoint()
        {
            var mainStart = new BranchPoint3d(0, 0, 10);
            var mainEnd = new BranchPoint3d(20, 0, 10);
            var split = new BranchPoint3d(10, 0, 10);
            var branch = new List<BranchPoint3d> { new BranchPoint3d(10, 0.05, 10), new BranchPoint3d(10, 8, 10) };

            var plan = MepBranchSplitGeometryPlanner.PlanLineSplit("duct", true, true, mainStart, mainEnd, branch, split, 0.05);

            Assert.True(plan.ApplySupported);
            Assert.Equal("tee", plan.ExpectedFitting);
            Assert.Equal(split, plan.SplitPoint);
            Assert.Equal(10, plan.DistanceFromMainStartFt);
            Assert.Equal(10, plan.DistanceFromMainEndFt);
        }

        [Fact]
        public void DuctLineTapPlanUsesTakeoffFittingWithoutChangingGeometryGuards()
        {
            var mainStart = new BranchPoint3d(0, 0, 10);
            var mainEnd = new BranchPoint3d(20, 0, 10);
            var split = new BranchPoint3d(10, 0, 10);
            var branch = new List<BranchPoint3d> { new BranchPoint3d(10, 0.05, 10), new BranchPoint3d(10, 8, 10) };

            var plan = MepBranchSplitGeometryPlanner.PlanLineSplit("duct", true, true, mainStart, mainEnd, branch, split, 0.05, "tap");

            Assert.True(plan.ApplySupported);
            Assert.Equal("tap", plan.Mode);
            Assert.Equal("takeoff", plan.ExpectedFitting);
            Assert.Equal(split, plan.SplitPoint);
        }

        [Fact]
        public void DuctLineSplitPlanBlocksWhenProjectedPointIsTooCloseToEnd()
        {
            var mainStart = new BranchPoint3d(0, 0, 10);
            var mainEnd = new BranchPoint3d(20, 0, 10);
            var split = new BranchPoint3d(0.25, 0, 10);
            var branch = new List<BranchPoint3d> { new BranchPoint3d(0.25, 0, 10), new BranchPoint3d(0.25, 8, 10) };

            var plan = MepBranchSplitGeometryPlanner.PlanLineSplit("duct", true, true, mainStart, mainEnd, branch, split, 0);

            Assert.False(plan.ApplySupported);
            Assert.Equal("split_too_close_to_main_end", plan.BlockCode);
        }

        [Fact]
        public void PipeLineSplitPlanSupportsSafeProjectedMidpointTee()
        {
            var mainStart = new BranchPoint3d(0, 0, 10);
            var mainEnd = new BranchPoint3d(20, 0, 10);
            var split = new BranchPoint3d(10, 0, 10);
            var branch = new List<BranchPoint3d> { split, new BranchPoint3d(10, 8, 10) };

            var plan = MepBranchSplitGeometryPlanner.PlanLineSplit("pipe", true, true, mainStart, mainEnd, branch, split, 0);

            Assert.True(plan.ApplySupported);
            Assert.Equal("tee", plan.Mode);
            Assert.Equal("tee", plan.ExpectedFitting);
            Assert.Equal(split, plan.SplitPoint);
        }

        [Fact]
        public void PipeTapPlanUsesTakeoffFittingWithSameGeometryGuards()
        {
            var mainStart = new BranchPoint3d(0, 0, 10);
            var mainEnd = new BranchPoint3d(20, 0, 10);
            var split = new BranchPoint3d(10, 0, 10);
            var branch = new List<BranchPoint3d> { split, new BranchPoint3d(10, 8, 10) };

            var plan = MepBranchSplitGeometryPlanner.PlanLineSplit("pipe", true, true, mainStart, mainEnd, branch, split, 0, "tap");

            Assert.True(plan.ApplySupported);
            Assert.Equal("tap", plan.Mode);
            Assert.Equal("takeoff", plan.ExpectedFitting);
            Assert.Equal(split, plan.SplitPoint);
        }

        [Fact]
        public void DuctLineSplitPlanBlocksWhenBranchStartIsNotOnMain()
        {
            var mainStart = new BranchPoint3d(0, 0, 10);
            var mainEnd = new BranchPoint3d(20, 0, 10);
            var split = new BranchPoint3d(10, 0, 10);
            var branch = new List<BranchPoint3d> { new BranchPoint3d(10, 2, 10), new BranchPoint3d(10, 8, 10) };

            var plan = MepBranchSplitGeometryPlanner.PlanLineSplit("duct", true, true, mainStart, mainEnd, branch, split, 2);

            Assert.False(plan.ApplySupported);
            Assert.Equal("branch_start_too_far", plan.BlockCode);
        }

        [Fact]
        public void DuctLineSplitPlanBlocksCurvedMain()
        {
            var mainStart = new BranchPoint3d(0, 0, 10);
            var mainEnd = new BranchPoint3d(20, 0, 10);
            var split = new BranchPoint3d(10, 0, 10);
            var branch = new List<BranchPoint3d> { split, new BranchPoint3d(10, 8, 10) };

            var plan = MepBranchSplitGeometryPlanner.PlanLineSplit("duct", true, false, mainStart, mainEnd, branch, split, 0);

            Assert.False(plan.ApplySupported);
            Assert.Equal("main_curve_not_line", plan.BlockCode);
        }
    }
}
