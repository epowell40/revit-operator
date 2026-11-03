using System;
using System.Collections.Generic;
using System.Linq;
using System.Text.Json;
using Xunit;

namespace RevitBridge.Common.Tests
{
    public class OperatorSheetRenderObservationTests
    {
        private static OperatorSheetRenderView View(long id, bool active = false) => new OperatorSheetRenderView
        { Id = id, UniqueId = "uid-" + id, TemporaryModes = new Dictionary<string, bool> { ["TemporaryHideIsolate"] = active } };

        [Fact]
        public void CompleteObservationsRetainActiveModesAndCopyCoordinatesWithoutCertifyingRendering()
        {
            var corners = new[] { new[] { 0d, 0d, 0d }, new[] { 4d, 3d, 0d } };
            var observed = OperatorSheetRenderObservation.Create(41, "uid-41", new[] { "TemporaryHideIsolate" }, new[] { View(51, true), View(41) }, corners);
            corners[0][0] = 99;
            using var json = JsonDocument.Parse(JsonSerializer.Serialize(observed));
            var root = json.RootElement;
            Assert.Equal("available", root.GetProperty("state").GetString());
            Assert.Equal(0, root.GetProperty("activeViewportCornersXyz")[0][0].GetDouble());
            Assert.Equal(41, root.GetProperty("views")[0].GetProperty("viewId").GetInt64());
            Assert.True(root.GetProperty("views")[1].GetProperty("temporaryModes")[0].GetProperty("active").GetBoolean());
            Assert.Contains("no model, file", root.GetProperty("limits").GetString());
        }

        [Theory]
        [InlineData("missing-mode")][InlineData("missing-sheet")][InlineData("duplicate-id")][InlineData("duplicate-uid")]
        [InlineData("too-many")][InlineData("missing-uid")][InlineData("bad-corners")][InlineData("extra-mode")]
        public void IncompleteOrAmbiguousInputDoesNotProduceAnAvailableObservation(string failure)
        {
            var views = new List<OperatorSheetRenderView> { View(41), View(51) };
            double[][]? corners = null;
            if (failure == "missing-mode") views[1].TemporaryModes.Clear();
            if (failure == "extra-mode") views[1].TemporaryModes["unknown"] = false;
            if (failure == "missing-sheet") views.RemoveAt(0);
            if (failure == "duplicate-id") views[1].Id = 41;
            if (failure == "duplicate-uid") views[1].UniqueId = "uid-41";
            if (failure == "missing-uid") views[1].UniqueId = "";
            if (failure == "too-many") views.AddRange(Enumerable.Range(100, 128).Select(id => View(id)));
            if (failure == "bad-corners") corners = new[] { new[] { double.NaN, 0d, 0d }, new[] { 4d, 3d, 0d } };
            Assert.ThrowsAny<Exception>(() => OperatorSheetRenderObservation.Create(41, "uid-41", new[] { "TemporaryHideIsolate" }, views, corners));
        }

        [Fact]
        public void UnavailableDoesNotInventEmptyViewsOrInactiveModes()
        {
            using var json = JsonDocument.Parse(JsonSerializer.Serialize(OperatorSheetRenderObservation.Unavailable()));
            Assert.Equal("unavailable", json.RootElement.GetProperty("state").GetString());
            Assert.False(json.RootElement.TryGetProperty("views", out _));
        }
    }
}
