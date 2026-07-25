using RevitBridge.Common;
using Xunit;

namespace RevitBridge.Common.Tests
{
    public sealed class ParameterValueMatchPolicyTests
    {
        [Fact]
        public void Exact_value_does_not_accept_substring_neighbors()
        {
            Assert.True(ParameterValueMatchPolicy.Matches("1-2", null, "1-2", caseSensitive: true));
            Assert.False(ParameterValueMatchPolicy.Matches("1-22", null, "1-2", caseSensitive: true));
            Assert.False(ParameterValueMatchPolicy.Matches("Render Material 0-191-255", null, "1-2", caseSensitive: true));
        }

        [Fact]
        public void Contains_value_retains_literal_replacement_discovery_semantics()
        {
            Assert.True(ParameterValueMatchPolicy.Matches("B3-G-SA-01", "-G-", null, caseSensitive: true));
            Assert.False(ParameterValueMatchPolicy.Matches("B3-0-SA-01", "-G-", null, caseSensitive: true));
        }

        [Fact]
        public void Exact_value_honors_case_sensitivity()
        {
            Assert.True(ParameterValueMatchPolicy.Matches("AHU-1", null, "ahu-1", caseSensitive: false));
            Assert.False(ParameterValueMatchPolicy.Matches("AHU-1", null, "ahu-1", caseSensitive: true));
        }
    }
}
