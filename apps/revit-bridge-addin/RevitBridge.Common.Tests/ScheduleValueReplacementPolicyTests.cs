using RevitBridge.Common;
using Xunit;

namespace RevitBridge.Common.Tests
{
    public sealed class ScheduleValueReplacementPolicyTests
    {
        [Theory]
        [InlineData("Designation", "DESIG", true)]
        [InlineData("DOAS_DESIG", "DESIG", true)]
        [InlineData("Designation Comments", "COMMENTS", false)]
        [InlineData("Tag", "TAG", false)]
        public void Field_match_uses_exact_normalized_parameter_or_heading(string parameterName, string heading, bool expected)
        {
            Assert.Equal(expected, ScheduleValueReplacementPolicy.FieldNameMatchesAny(parameterName, heading, new[] { "DESIG", "Designation" }));
        }

        [Fact]
        public void Literal_replacement_changes_every_exact_occurrence_only()
        {
            Assert.True(ScheduleValueReplacementPolicy.TryBuildLiteralReplacement("B3-G-IA-01-G-A", "-G-", "-0-", out var next));
            Assert.Equal("B3-0-IA-01-0-A", next);
            Assert.False(ScheduleValueReplacementPolicy.TryBuildLiteralReplacement("B3-g-IA-01", "-G-", "-0-", out _));
        }
    }
}
