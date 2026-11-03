using System;
using System.IO;
using System.Text.Json;
using RevitBridge.Common;
using Xunit;

namespace RevitBridge.Common.Tests
{
    public sealed class InlineAccessoryRetainedSplitTests
    {
        [Theory]
        [InlineData("10.083333333333332", "Double", true)]
        [InlineData("10.083333333433334", "Double", false)]
        [InlineData("NaN", "Double", false)]
        [InlineData("Infinity", "Double", false)]
        [InlineData("1e999", "Double", false)]
        [InlineData("", "Double", false)]
        [InlineData(" 10.083333333333334", "Double", false)]
        [InlineData("10.083333333333334", "String", false)]
        public void ElevationExceptionIsFiniteTypedAndTightlyBounded(string value, string storage, bool expected)
        {
            foreach (var id in new[] { -1141029, -1140240, -1141026, -1141020, -1140239, -1141021, -1114132 })
            {
                var before = JsonSerializer.Serialize(new[] { new { id, storage = "Double", value = "10.083333333333334" } });
                var after = JsonSerializer.Serialize(new[] { new { id, storage, value } });
                Assert.Equal(expected, InlineAccessoryParameterPreservation.Matches(before, after, false));
                Assert.Equal(expected, InlineAccessoryParameterPreservation.Matches(before, after, true));
            }
        }
        [Theory]
        [InlineData(0, false)] [InlineData(0, true)]
        [InlineData(1, false)] [InlineData(1, true)]
        public void ActualUiSplitPreservesWritableDataDespiteCopiedIfcAndElevationRoundoff(int index, bool created)
        {
            using var fixture = JsonDocument.Parse(File.ReadAllText(Path.Combine(AppContext.BaseDirectory, "Fixtures", "inline-split-parameters83.json")));
            var root = fixture.RootElement;
            Assert.True(InlineAccessoryParameterPreservation.Matches(root.GetProperty("before").GetString()!,
                root.GetProperty("splits")[index].GetProperty(created ? "created" : "retained").GetString()!, created));
        }
    }
}
