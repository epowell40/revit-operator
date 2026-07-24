using RevitBridge.Common;
using Xunit;

namespace RevitBridge.Common.Tests
{
    public sealed class ScheduleCellUpdatePolicyTests
    {
        [Theory]
        [InlineData("Supply Air", "Supply Air", "SUPPLY AIR")]
        [InlineData("supply-air", "Supply Air", "Airflow")]
        [InlineData("Supply Air", "Supply Airflow", "Supply Air CFM")]
        [InlineData("DESIG", "Designation", "DESIG")]
        public void FieldNameMatches_NormalizesHeadings(string requested, string parameterName, string heading)
        {
            Assert.True(ScheduleCellUpdatePolicy.FieldNameMatches(requested, parameterName, heading));
        }

        [Theory]
        [InlineData("Mark", "")]
        [InlineData("Designation", "DESIG")]
        [InlineData("Equipment Number", "EQUIP NO.")]
        [InlineData("Equipment Tag", "TAG NO.")]
        public void IdentifierAliases_AreRecognized(string parameterName, string heading)
        {
            Assert.True(ScheduleCellUpdatePolicy.IsLikelyIdentifierField(parameterName, heading));
        }

        [Fact]
        public void ValueMatches_AllowsOmittedScheduleUnitSuffix()
        {
            Assert.True(ScheduleCellUpdatePolicy.ValueMatches("10,000", null, "10,000 CFM"));
            Assert.True(ScheduleCellUpdatePolicy.ValueMatches("AHU-1", "ahu-1", null));
        }

        [Fact]
        public void ValueMatches_DoesNotIgnoreExplicitUnitMismatch()
        {
            Assert.False(ScheduleCellUpdatePolicy.ValueMatches("10,000 GPM", null, "10,000 CFM"));
        }

        [Fact]
        public void ValueMatches_DoesNotTreatRawInternalUnitsAsVisibleScheduleUnits()
        {
            Assert.False(ScheduleCellUpdatePolicy.ValueMatches("10,000", "10000", "600,000 CFM"));
        }
    }
}
