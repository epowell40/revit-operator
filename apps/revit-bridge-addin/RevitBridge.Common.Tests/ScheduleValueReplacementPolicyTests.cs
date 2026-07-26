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
        public void Field_precedence_uses_designation_before_mark_fallback()
        {
            var available = new[]
            {
                (ParameterName: (string?)"Mark", Heading: (string?)"TAG"),
                (ParameterName: (string?)"DESIG.", Heading: (string?)"Designation")
            };

            Assert.Equal(
                "DESIG",
                ScheduleValueReplacementPolicy.FirstMatchingRequestedName(
                    new[] { "DESIG", "Designation", "Mark" },
                    available));
        }

        [Fact]
        public void Field_precedence_uses_mark_only_when_designation_is_absent()
        {
            var available = new[]
            {
                (ParameterName: (string?)"Mark", Heading: (string?)"TAG")
            };

            Assert.Equal(
                "Mark",
                ScheduleValueReplacementPolicy.FirstMatchingRequestedName(
                    new[] { "DESIG", "Designation", "Mark" },
                    available));
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
