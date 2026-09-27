using System;
using System.Linq;
using System.Text.Json;
using Xunit;

namespace RevitBridge.Common.Tests
{
    public sealed class OperatorViewImageContractTests
    {
        private static double[][] Corners() => new[] { new[] { -10.0, 20.0, 40.0 }, new[] { 12.0, -5.0, 40.0 } };

        [Theory]
        [InlineData(null, "full_view")]
        [InlineData("full_view", "full_view")]
        [InlineData("visible_region", "visible_region")]
        public void ExportModeIsExplicitAndLegacyDefaultIsUnchanged(string? supplied, string expected)
            => Assert.Equal(expected, OperatorViewImageContract.ResolveMode(supplied));

        [Theory]
        [InlineData("")]
        [InlineData("VISIBLE_REGION")]
        [InlineData("current_view")]
        [InlineData("visible_region ")]
        public void UnknownModesCannotSilentlyFallBack(string mode)
            => Assert.Throws<ArgumentException>(() => OperatorViewImageContract.ResolveMode(mode));

        [Fact]
        public void PublishedEnumMatchesTheNativeModeParser()
        {
            using var schema = JsonDocument.Parse(JsonSerializer.Serialize(OperatorViewImageContract.ExportModeSchema()));
            Assert.Equal("string", schema.RootElement.GetProperty("type").GetString());
            var modes = schema.RootElement.GetProperty("enum").EnumerateArray().Select(x => x.GetString()).ToArray();
            Assert.Equal(new[] { "full_view", "visible_region" }, modes);
            foreach (var mode in modes) Assert.Equal(mode, OperatorViewImageContract.ResolveMode(mode));
        }

        [Theory]
        [InlineData(42L, 41L, 42L)]
        [InlineData(42L, 42L, 41L)]
        [InlineData(42L, 42L, null)]
        [InlineData(42L, null, 42L)]
        [InlineData(0L, 0L, 0L)]
        public void RequestedActualAndUiViewMustAllMatch(long requested, long? active, long? ui)
            => Assert.Throws<InvalidOperationException>(() => OperatorViewImageContract.RequireViewport(requested, active, ui, Corners()));

        [Fact]
        public void InvalidOrUnavailableCornersRejectRatherThanInventingFraming()
        {
            foreach (var invalid in new double[][]?[] { null, Array.Empty<double[]>(), new[] { new double[3] },
                new[] { new double[3], new double[2] }, new[] { new double[3], new double[3] },
                new[] { new[] { double.NaN, 0d, 1d }, new double[3] },
                new[] { new[] { 1d, 0d, double.PositiveInfinity }, new double[3] } })
                Assert.Throws<InvalidOperationException>(() => OperatorViewImageContract.RequireViewport(42, 42, 42, invalid));
        }

        [Fact]
        public void ActualCornersAreCopiedAndPostExportViewOrViewportChangesReject()
        {
            var corners = Corners();
            var before = OperatorViewImageContract.RequireViewport(42, 42, 42, corners);
            corners[0][0] = 999;
            Assert.Equal(-10, before.ZoomCornersXyz[0][0]);
            OperatorViewImageContract.RequireUnchanged(before, OperatorViewImageContract.RequireViewport(42, 42, 42, Corners()));
            Assert.Throws<InvalidOperationException>(() => OperatorViewImageContract.RequireUnchanged(before,
                OperatorViewImageContract.RequireViewport(43, 43, 43, Corners())));
            Assert.Throws<InvalidOperationException>(() => OperatorViewImageContract.RequireUnchanged(before,
                OperatorViewImageContract.RequireViewport(42, 42, 42, corners)));
        }

        [Fact]
        public void ObliqueDisplayPlaneCornersAreRetainedWithoutInventingThreeDimensionalMapping()
        {
            var corners = new[] { new[] { -10d, 20d, 5d }, new[] { 12d, -5d, 40d } };
            var result = OperatorViewImageContract.RequireViewport(42, 42, 42, corners);
            Assert.Equal(corners[0], result.ZoomCornersXyz[0]);
            Assert.Equal(corners[1], result.ZoomCornersXyz[1]);
        }
    }
}
