using RevitBridge.Common;
using Xunit;

namespace RevitBridge.Common.Tests
{
    public class RevitTextCasePolicyTests
    {
        [Fact]
        public void NormalizeSheetName_UppercasesAndTrims()
        {
            Assert.Equal("ELECTRICAL DETAILS", RevitTextCasePolicy.NormalizeSheetName("  Electrical Details  "));
        }

        [Fact]
        public void NormalizeDraftingText_UppercasesMultilineText()
        {
            Assert.Equal("COORDINATE\nWITH ARCHITECT", RevitTextCasePolicy.NormalizeDraftingText("Coordinate\nwith architect"));
        }

        [Theory]
        [InlineData("Sheet Name", "Electrical Details", true)]
        [InlineData("Comments", "revise per sketch", true)]
        [InlineData("Email", "designer@example.com", false)]
        [InlineData("File Path", "C:\\Temp\\details.txt", false)]
        public void ShouldNormalizeParameter_RecognizesDraftingTextAndProtectedValues(string name, string value, bool expected)
        {
            Assert.Equal(expected, RevitTextCasePolicy.ShouldNormalizeParameterName(name, value));
        }
    }
}
