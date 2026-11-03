using System;
using RevitBridge.Common;
using Xunit;

namespace RevitBridge.Common.Tests
{
    public sealed class InlineAccessoryGeometryTests
    {
        private static BranchPoint3d P(double x, double y = 0, double z = 0) => new BranchPoint3d(x, y, z);
        // Retained original73 host lengths and current-family-type port spacing.
        // Six-inch instance port diameters remain hypothetical until a native fit.
        [Theory]
        [InlineData(0.9544853035290455)]
        [InlineData(4)]
        public void MeasuredSixInchPortsKeepOriginalSpan(double length)
        {
            var plan = InlineAccessoryGeometry.Plan(P(0), P(length), P(length / 2), .5, .5, .5, .5, .01);
            Assert.Equal(length, plan.FirstRetainedLengthFt + plan.AccessoryLengthFt + plan.SecondRetainedLengthFt, 12);
            Assert.Equal(length / 2 - .25, plan.FirstPort.X, 12);
            Assert.Equal(length / 2 + .25, plan.SecondPort.X, 12);
        }
        [Fact] public void TwelveInchDefinitionCannotVerifySixInchInstance()
            => Assert.Throws<ArgumentException>(() => InlineAccessoryGeometry.Plan(P(0), P(4), P(2), .125, .5, 1, 1, .01));
        [Theory]
        [InlineData(.1, 0, .2)] // too close to an endpoint
        [InlineData(2, .01, .2)] // off the existing route
        [InlineData(2, 0, 4)] // no retained segments
        [InlineData(-1, 0, .2)]
        [InlineData(5, 0, .2)]
        public void InvalidPlacementCannotProducePlan(double x, double y, double spacing)
            => Assert.Throws<ArgumentException>(() => InlineAccessoryGeometry.Plan(P(0), P(4), P(x, y), spacing, .5, .5, .5, .01));
        [Theory]
        [InlineData(double.NaN)]
        [InlineData(double.PositiveInfinity)]
        [InlineData(0)]
        [InlineData(-1)]
        public void NonFiniteAndInvalidSizeFailClosed(double value)
            => Assert.Throws<ArgumentException>(() => InlineAccessoryGeometry.Plan(P(0), P(4), P(2), value, .5, .5, .5, .01));
        [Fact] public void ReversedAndSlopingRoutesUseActualAxis()
        {
            var plan = InlineAccessoryGeometry.Plan(P(4, 4, 4), P(0, 0, 0), P(2, 2, 2), 1, .5, .5, .5, .01);
            Assert.True(plan.FirstPort.X > plan.SecondPort.X);
            Assert.Equal(Math.Sqrt(48), plan.FirstRetainedLengthFt + plan.AccessoryLengthFt + plan.SecondRetainedLengthFt, 12);
        }
        [Fact] public void RequiresOutwardOpposedPortsNotJustTwoOrigins()
        {
            InlineAccessoryGeometry.RequireOpposingAxialPorts(P(0), P(1), P(-1), P(1));
            Assert.Throws<ArgumentException>(() => InlineAccessoryGeometry.RequireOpposingAxialPorts(P(0), P(1), P(1), P(-1)));
            Assert.Throws<ArgumentException>(() => InlineAccessoryGeometry.RequireOpposingAxialPorts(P(0), P(1), P(0, 1), P(0, -1)));
            Assert.Throws<ArgumentException>(() => InlineAccessoryGeometry.RequireOpposingAxialPorts(P(0), P(0), P(-1), P(1)));
            Assert.Throws<ArgumentException>(() => InlineAccessoryGeometry.RequireOpposingAxialPorts(P(0), P(1), P(-2), P(2)));
        }
    }
}
