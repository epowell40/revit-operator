using System;
using RevitBridge.Common;
using Xunit;

public sealed class DraftPointCoordinatePolicyTests
{
    [Fact]
    public void RetainedPixelPlusWorldElevationIsRejectedInsteadOfSilentlyChangingHeight()
    {
        var ex = Assert.Throws<InvalidOperationException>(() => DraftPointCoordinatePolicy.Validate(null, 1208, 1002, null, null, null, null, 44.16666666667046, "be9869fb43fe406fb664aa683d490c88"));
        Assert.Contains("xyz:[x,y,z]", ex.Message);
        Assert.Throws<InvalidOperationException>(() => DraftPointCoordinatePolicy.Validate(null, null, null, 1, 2, null, null, 44, null));
        Assert.Throws<InvalidOperationException>(() => DraftPointCoordinatePolicy.Validate(null, null, null, null, null, 1, 2, 44, "frame"));
        DraftPointCoordinatePolicy.Validate(new[] { -15.99, -17.52, 44.16666666667046 }, null, null, null, null, null, null, null, "frame");
        DraftPointCoordinatePolicy.Validate(null, null, null, null, null, 1, 2, 44, null);
        DraftPointCoordinatePolicy.Validate(null, 1, 2, null, null, null, null, null, "frame");
        DraftPointCoordinatePolicy.Validate(new[] { 1.0, 2.0 }, null, null, null, null, null, null, null, null);
    }

    [Fact]
    public void AmbiguousPartialAndNonfiniteCoordinatesFailBeforeResolution()
    {
        foreach (var point in new[] { new[] { 1.0 }, new[] { 1.0, 2.0, 3.0, 4.0 }, new[] { double.NaN, 2.0 }, new[] { 1.0, double.PositiveInfinity } })
            Assert.Throws<InvalidOperationException>(() => DraftPointCoordinatePolicy.Validate(point, null, null, null, null, null, null, null, null));
        Assert.Throws<InvalidOperationException>(() => DraftPointCoordinatePolicy.Validate(new[] { 1.0, 2.0, 3.0 }, 1, 2, null, null, null, null, null, "frame"));
        Assert.Throws<InvalidOperationException>(() => DraftPointCoordinatePolicy.Validate(null, 1, null, null, null, null, null, null, "frame"));
        Assert.Throws<InvalidOperationException>(() => DraftPointCoordinatePolicy.Validate(null, null, null, null, null, null, null, 44, null));
    }
}
