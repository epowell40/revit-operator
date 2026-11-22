using System;
using System.Text.Json;
using RevitBridge.Common;
using Xunit;

namespace RevitBridge.Common.Tests
{
    public sealed class ElementLocationObservationTests
    {
        private static JsonElement Json(object value) => JsonSerializer.SerializeToElement(value);

        [Fact] public void PointUsesInsertionPointAndRadiansWithoutClaimingConnectorOrHostFit()
        {
            var r = Json(ElementLocationObservation.Point(() => new[] { 16.55, -17.0, 42.833 }, () => Math.PI));
            Assert.Equal("observed", r.GetProperty("status").GetString());
            Assert.Equal("document_internal", r.GetProperty("coordinateSpace").GetString());
            Assert.Equal("feet", r.GetProperty("lengthUnits").GetString());
            Assert.Equal(16.55, r.GetProperty("point")[0].GetDouble());
            Assert.Equal(Math.PI, r.GetProperty("rotationRadians").GetDouble());
            Assert.False(r.TryGetProperty("host", out _));
            Assert.False(r.TryGetProperty("verified", out _));
        }

        [Fact] public void UnsupportedRotationKeepsGoodPointAndDoesNotInventZero()
        {
            var r = Json(ElementLocationObservation.Point(() => new[] { 1.0, 2.0, 3.0 }, () => throw new Exception("private")));
            Assert.Equal("partial", r.GetProperty("status").GetString());
            Assert.Equal(1, r.GetProperty("point")[0].GetDouble());
            Assert.Equal("unavailable", r.GetProperty("rotationStatus").GetString());
            Assert.False(r.TryGetProperty("rotationRadians", out _));
            Assert.DoesNotContain("private", r.GetRawText());
        }

        [Theory] [InlineData(double.NaN)] [InlineData(double.PositiveInfinity)]
        public void InvalidCoordinatesRemainUnavailableButOtherFieldsSurvive(double bad)
        {
            var r = Json(ElementLocationObservation.Point(() => new[] { bad, 2.0, 3.0 }, () => 0));
            Assert.Equal("partial", r.GetProperty("status").GetString());
            Assert.False(r.TryGetProperty("point", out _));
            Assert.Equal(0, r.GetProperty("rotationRadians").GetDouble());
        }

        [Fact] public void CurveEndpointsAreNotClaimedAsCompleteCurvedGeometry()
        {
            var r = Json(ElementLocationObservation.Curve(false, true, () => new[] { 1.0, 2.0, 3.0 }, () => new[] { 4.0, 5.0, 6.0 }));
            Assert.Equal("curve", r.GetProperty("kind").GetString());
            Assert.Equal("endpoints_only_not_full_curve", r.GetProperty("scope").GetString());
            Assert.Equal(4, r.GetProperty("end")[0].GetDouble());
            var line = Json(ElementLocationObservation.Curve(true, true, () => new[] { 1.0, 2.0, 3.0 }, () => throw new Exception()));
            Assert.Equal("line", line.GetProperty("kind").GetString());
            Assert.Equal("partial", line.GetProperty("status").GetString());
            Assert.True(line.TryGetProperty("start", out _));
            Assert.False(line.TryGetProperty("end", out _));
        }

        [Fact] public void UnboundedCurveDoesNotReadInvalidEndpoints()
        {
            var r = Json(ElementLocationObservation.Curve(false, false, () => throw new Exception(), () => throw new Exception()));
            Assert.Equal("unavailable_unbounded", r.GetProperty("endpointsStatus").GetString());
            Assert.False(r.TryGetProperty("start", out _));
            Assert.Equal("unavailable", Json(ElementLocationObservation.Unavailable("location_read_failed")).GetProperty("status").GetString());
        }
    }
}
