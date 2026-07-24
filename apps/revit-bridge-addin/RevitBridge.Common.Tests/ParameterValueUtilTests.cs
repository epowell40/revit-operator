using RevitBridge.Common;
using Xunit;

namespace RevitBridge.Common.Tests
{
    public class ParameterValueUtilTests
    {
        [Fact]
        public void SnapshotMatchesRequestedValue_MatchesIntegerSnapshot()
        {
            var snapshot = new
            {
                storageType = "Integer",
                value = 10000,
                valueString = "10000"
            };

            Assert.True(ParameterValueUtil.SnapshotMatchesRequestedValue(snapshot, "10000"));
            Assert.False(ParameterValueUtil.SnapshotMatchesRequestedValue(snapshot, "12000"));
        }

        [Fact]
        public void SnapshotMatchesRequestedValue_MatchesStringSnapshot()
        {
            var snapshot = new
            {
                storageType = "String",
                value = "P102",
                valueString = "P102"
            };

            Assert.True(ParameterValueUtil.SnapshotMatchesRequestedValue(snapshot, "P102"));
            Assert.False(ParameterValueUtil.SnapshotMatchesRequestedValue(snapshot, "P105"));
        }

        [Fact]
        public void SnapshotMatchesExpectedCurrentValue_MatchesRevitFormattedDouble()
        {
            var snapshot = new
            {
                storageType = "Double",
                value = 166.6666666667,
                valueString = "10,000 CFM"
            };

            Assert.True(ParameterValueUtil.SnapshotMatchesExpectedCurrentValue(snapshot, "10000 cfm"));
            Assert.True(ParameterValueUtil.SnapshotMatchesExpectedCurrentValue(snapshot, "10,000 CFM"));
            Assert.False(ParameterValueUtil.SnapshotMatchesExpectedCurrentValue(snapshot, "20,000 CFM"));
        }
    }
}
