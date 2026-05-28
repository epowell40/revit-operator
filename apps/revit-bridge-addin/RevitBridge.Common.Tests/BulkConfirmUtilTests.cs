using RevitBridge.Common;
using System;
using Xunit;

namespace RevitBridge.Common.Tests
{
    public class BulkConfirmUtilTests
    {
        [Theory]
        [InlineData(null, "")]
        [InlineData("", "")]
        [InlineData("  APPLY 34 CHANGES  ", "APPLY 34 CHANGES")]
        [InlineData("**APPLY 34 CHANGES**", "APPLY 34 CHANGES")]
        [InlineData("__APPLY 34 CHANGES__", "APPLY 34 CHANGES")]
        [InlineData("*APPLY 34 CHANGES*", "APPLY 34 CHANGES")]
        [InlineData("`APPLY 34 CHANGES`", "APPLY 34 CHANGES")]
        [InlineData("\n**APPLY 34  CHANGES**\r\n", "APPLY 34 CHANGES")]
        [InlineData("\"APPLY 34 CHANGES\"", "APPLY 34 CHANGES")]
        public void Normalize_StripsWrappersAndWhitespace(string input, string expected)
        {
            Assert.Equal(expected, BulkConfirmUtil.Normalize(input));
        }

        [Theory]
        [InlineData("**APPLY 34 CHANGES**", "APPLY 34 CHANGES", true)]
        [InlineData(" APPLY 34 CHANGES\n", "APPLY 34 CHANGES", true)]
        [InlineData("APPLY 35 CHANGES", "APPLY 34 CHANGES", false)]
        public void EqualsNormalized_Works(string got, string expected, bool ok)
        {
            Assert.Equal(ok, BulkConfirmUtil.EqualsNormalized(got, expected));
        }

        [Fact]
        public void EqualsNormalized_AllowsYesForBulkApply_WhenEnabled()
        {
            var prev = Environment.GetEnvironmentVariable("OPERATOR_BULK_CONFIRM_SIMPLE");
            try
            {
                Environment.SetEnvironmentVariable("OPERATOR_BULK_CONFIRM_SIMPLE", "1");
                Assert.True(BulkConfirmUtil.EqualsNormalized("yes", "APPLY 38 CHANGES"));
                Assert.True(BulkConfirmUtil.EqualsNormalized(" ok ", "DELETE 2 ELEMENTS"));
                Assert.True(BulkConfirmUtil.EqualsNormalized("apply", "APPLY 1 TEXT NOTE CHANGE"));
            }
            finally
            {
                Environment.SetEnvironmentVariable("OPERATOR_BULK_CONFIRM_SIMPLE", prev);
            }
        }

        [Fact]
        public void EqualsNormalized_DoesNotAllowYes_WhenDisabled()
        {
            var prev = Environment.GetEnvironmentVariable("OPERATOR_BULK_CONFIRM_SIMPLE");
            try
            {
                Environment.SetEnvironmentVariable("OPERATOR_BULK_CONFIRM_SIMPLE", "0");
                Assert.False(BulkConfirmUtil.EqualsNormalized("yes", "APPLY 38 CHANGES"));
            }
            finally
            {
                Environment.SetEnvironmentVariable("OPERATOR_BULK_CONFIRM_SIMPLE", prev);
            }
        }
    }
}
