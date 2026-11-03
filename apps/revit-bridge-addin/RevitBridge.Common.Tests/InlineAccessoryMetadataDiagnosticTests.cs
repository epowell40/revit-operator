using RevitBridge.Common;
using Xunit;
namespace RevitBridge.Common.Tests
{
    public sealed class InlineAccessoryMetadataDiagnosticTests
    {
        const string Before = "{\"type\":1,\"phase\":2,\"demolished\":-1,\"workset\":0,\"systemType\":3,\"level\":4,\"diameter\":0.5}";
        [Theory]
        [InlineData("type", "1", "9")]
        [InlineData("phase", "2", "9")]
        [InlineData("demolished", "-1", "9")]
        [InlineData("workset", "0", "9")]
        [InlineData("systemType", "3", "null")]
        [InlineData("level", "4", "null")]
        [InlineData("diameter", "0.5", "0.5000000000000001")]
        public void ReportsExactNativeFieldDifferenceWithoutRelaxingIt(string field, string oldValue, string newValue)
        {
            var after = Before.Replace("\"" + field + "\":" + oldValue, "\"" + field + "\":" + newValue);
            Assert.Equal("metadata; differences=" + field + ":" + oldValue + "->" + newValue,
                InlineAccessoryMetadataDiagnostic.Describe(Before, after));
        }
        [Fact] public void UnknownOrMalformedInputCannotInventADifference()
        {
            Assert.Equal("metadata; differences=unavailable", InlineAccessoryMetadataDiagnostic.Describe("[", Before));
            Assert.Equal("metadata; differences=unavailable", InlineAccessoryMetadataDiagnostic.Describe("{}", Before));
            Assert.Equal("metadata; differences=unavailable", InlineAccessoryMetadataDiagnostic.Describe(Before, Before.Replace("0.5", "\"secret\"")));
            Assert.Equal("metadata; differences=unavailable", InlineAccessoryMetadataDiagnostic.Describe(Before, Before.Replace("\"type\":1", "\"extra\":1")));
            Assert.Equal("metadata; differences=unavailable", InlineAccessoryMetadataDiagnostic.Describe(Before, Before.Replace("\"type\":1", "\"phase\":1")));
            Assert.Equal("metadata; differences=unavailable", InlineAccessoryMetadataDiagnostic.Describe(Before, Before.Replace("0.5", "1e999")));
            Assert.Equal("metadata; differences=unavailable", InlineAccessoryMetadataDiagnostic.Describe(new string(' ', 4097), Before));
        }
        [Fact] public void IdenticalAndRepresentationOnlyAreExplicitDiagnosticStates()
        {
            Assert.Equal("metadata; differences=none", InlineAccessoryMetadataDiagnostic.Describe(Before, Before));
            Assert.Equal("metadata; differences=serialization_only", InlineAccessoryMetadataDiagnostic.Describe(Before, Before.Replace(",", ", ")));
        }
    }
}
