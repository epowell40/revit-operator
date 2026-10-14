using System;
using System.Text.Json;
using RevitBridge.Common;
using Xunit;

namespace RevitBridge.Common.Tests
{
    public class SheetViewportPlacementTests
    {
        [Fact]
        public void ProjectionPlacementRetainsOwnerOriginAndEveryBasisCoordinate()
        {
            var origin = new[] { 1.6286857837044004, 0.9031855905596113, 0.0 };
            var pose = SheetViewportPlacement.ProjectionAnchor(1391147, origin, new[] { 1.0, 0, 0 }, new[] { 0.0, 1, 0 }, new[] { 0.0, 0, 1 });
            origin[0] = 999;
            using var p = JsonDocument.Parse(JsonSerializer.Serialize(pose));
            Assert.Equal("ViewportProjectionOrigin", p.RootElement.GetProperty("kind").GetString());
            Assert.Equal(1391147, p.RootElement.GetProperty("ownerViewId").GetInt64());
            Assert.Equal(1.6286857837044004, p.RootElement.GetProperty("pointXyz")[0].GetDouble());
            foreach (var key in new[] { "pointXyz", "basisXXyz", "basisYXyz", "basisZXyz" })
                Assert.Equal(3, p.RootElement.GetProperty(key).GetArrayLength());
        }

        [Theory]
        [InlineData(0, 3, false)]
        [InlineData(1, 2, false)]
        [InlineData(1, 3, true)]
        public void MissingOwnerCoordinatesOrFiniteValuesCannotBeSerializedAsPlacement(long owner, int count, bool nonfinite)
        {
            var point = new double[count];
            if (nonfinite) point[0] = double.NaN;
            Assert.Throws<ArgumentException>(() => SheetViewportPlacement.ProjectionAnchor(owner, point, new double[3], new double[3], new double[3]));
        }
    }
}
