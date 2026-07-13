using System;
using System.Collections.Generic;
using RevitBridge.Common.FamilyEvolution;
using Xunit;

namespace RevitBridge.Common.Tests
{
    public sealed class FamilyEvolutionPlanTests
    {
        [Theory]
        [InlineData(1.70, 0.0, "right")]
        [InlineData(-1.70, 0.0, "left")]
        [InlineData(0.0, 2.05, "front")]
        [InlineData(0.0, -2.05, "back")]
        public void ResolveConnectorSide_UsesNearestEquipmentEdge(double x, double y, string expected)
        {
            Assert.Equal(expected, FamilyEvolutionPlan.ResolveConnectorSide(x, y, 10.0 / 3.0, 4.0));
        }

        [Fact]
        public void ResolveConnectorSide_MatchesHru403ElectricalConnectorFixture()
        {
            var side = FamilyEvolutionPlan.ResolveConnectorSide(1.715879265091864, -1.361548556430455, 3.33333333333333, 4.03543307086614);
            Assert.Equal("right", side);
        }

        [Fact]
        public void ResolveConnectorSide_FailsClosedAtAmbiguousCorner()
        {
            Assert.Throws<InvalidOperationException>(() => FamilyEvolutionPlan.ResolveConnectorSide(2.0, 2.0, 4.0, 4.0));
        }

        [Fact]
        public void ResolveConnectorSide_FailsClosedForInteriorConnector()
        {
            Assert.Throws<InvalidOperationException>(() => FamilyEvolutionPlan.ResolveConnectorSide(1.0, 0.25, 4.0, 4.0));
        }

        [Fact]
        public void BuildClearanceRectangle_RightSideStartsAtEquipmentEdgeAndExtendsThirtySixInches()
        {
            var segments = FamilyEvolutionPlan.BuildClearanceRectangle(44.0 / 12.0, 50.0 / 12.0, 3.0, "right");
            Assert.Equal(4, segments.Count);
            Assert.Equal(22.0 / 12.0, segments[0].X1, 8);
            Assert.Equal(58.0 / 12.0, segments[0].X2, 8);
            Assert.Equal(-25.0 / 12.0, segments[0].Y1, 8);
            Assert.Equal(25.0 / 12.0, segments[2].Y1, 8);
        }

        [Fact]
        public void ComputePlanHash_IsOrderIndependentAndDetectsDrift()
        {
            var a = FamilyEvolutionPlan.ComputePlanHash(new[]
            {
                new KeyValuePair<string, string>("instance", "1465049"),
                new KeyValuePair<string, string>("width", "3.66666667")
            });
            var b = FamilyEvolutionPlan.ComputePlanHash(new[]
            {
                new KeyValuePair<string, string>("width", "3.66666667"),
                new KeyValuePair<string, string>("instance", "1465049")
            });
            var drift = FamilyEvolutionPlan.ComputePlanHash(new[]
            {
                new KeyValuePair<string, string>("instance", "1465049"),
                new KeyValuePair<string, string>("width", "3.75")
            });
            Assert.Equal(a, b);
            Assert.NotEqual(a, drift);
        }
    }
}
