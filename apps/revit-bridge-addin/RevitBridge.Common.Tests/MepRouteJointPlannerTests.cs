using RevitBridge.Common;
using Xunit;

namespace RevitBridge.Common.Tests
{
    public class MepRouteJointPlannerTests
    {
        [Fact]
        public void PlanJointsExpectsTransitionWhenAdjacentSizesDiffer()
        {
            var plans = MepRouteJointPlanner.PlanJoints(new string?[] { "24x12", "12x8", "12x8" });

            Assert.Equal(2, plans.Count);
            Assert.Equal("transition", plans[0].ExpectedFitting);
            Assert.Equal("elbow_or_connect", plans[1].ExpectedFitting);
        }

        [Fact]
        public void PlanJointsNormalizesEquivalentDuctSizeText()
        {
            var plans = MepRouteJointPlanner.PlanJoints(new string?[] { "24 X 12 in", "24x12\"" });

            Assert.Single(plans);
            Assert.Equal("elbow_or_connect", plans[0].ExpectedFitting);
        }
    }
}
