using RevitBridge.Common;
using Xunit;
namespace RevitBridge.Common.Tests
{
    public sealed class InlineAccessoryParameterPreservationTests
    {
        // Before identity from retained native original75; after is a synthetic
        // desired-state neighbor, not evidence of a successful live insertion.
        const string Before = "[{\"id\":-1019000,\"storage\":\"String\",\"value\":\"1JbANhx6TBfudXEbM1T$P_\"},{\"id\":1,\"storage\":\"String\",\"value\":\"retain\"}]";
        const string After = "[{\"id\":-1019000,\"storage\":\"String\",\"value\":\"2JbANhx6TBfudXEbM1T$P_\"},{\"id\":1,\"storage\":\"String\",\"value\":\"retain\"}]";
        [Fact] public void NewSegmentMayHaveNewWritableIfcIdentity()
            => Assert.True(InlineAccessoryParameterPreservation.Matches(Before, After, true));
        [Fact] public void RetainedHostMustKeepItsExactIdentity()
        {
            Assert.True(InlineAccessoryParameterPreservation.Matches(Before, Before, false));
            Assert.False(InlineAccessoryParameterPreservation.Matches(Before, After, false));
        }
        [Fact] public void NewSegmentMayCopyWritableIfcIdentity()
            => Assert.True(InlineAccessoryParameterPreservation.Matches(Before, Before, true));
        [Theory]
        [InlineData("", "")]
        [InlineData("1JbANhx6TBfudXEbM1T$P_", "bad")]
        [InlineData("1JbANhx6TBfudXEbM1T$P_", "4JbANhx6TBfudXEbM1T$P_")]
        public void InvalidIfcIdentitiesCannotBeExcused(string before, string after)
            => Assert.False(InlineAccessoryParameterPreservation.Matches(Before.Replace("1JbANhx6TBfudXEbM1T$P_", before), After.Replace("2JbANhx6TBfudXEbM1T$P_", after), true));
        [Fact] public void OtherDataAndInventoryAreStillExact()
        {
            Assert.False(InlineAccessoryParameterPreservation.Matches(Before, After.Replace("retain", "changed"), true));
            Assert.False(InlineAccessoryParameterPreservation.Matches(Before, "[]", true));
            Assert.False(InlineAccessoryParameterPreservation.Matches("[]", After, true));
            Assert.False(InlineAccessoryParameterPreservation.Matches(Before, After.Replace("\"id\":1,", "\"id\":-1019000,"), true));
            Assert.False(InlineAccessoryParameterPreservation.Matches(Before, After.Replace("\"storage\":\"String\"", "\"storage\":\"Integer\""), true));
            Assert.False(InlineAccessoryParameterPreservation.Matches(Before, After.Replace("\"value\":\"retain\"", "\"value\":12"), true));
            Assert.False(InlineAccessoryParameterPreservation.Matches("null", "null", true));
            Assert.False(InlineAccessoryParameterPreservation.Matches("[", "[", false));
            Assert.False(InlineAccessoryParameterPreservation.Matches(Before, After.Replace("\"id\":1,", "\"extra\":1,\"id\":1,"), true));
            Assert.True(InlineAccessoryParameterPreservation.Matches("[]", "[]", true));
        }
        [Fact] public void DoubleRoundoffIsNotGloballyRelaxed()
        {
            const string p = "[{\"id\":1,\"storage\":\"Double\",\"value\":\"10.0833333333333\"}]";
            Assert.False(InlineAccessoryParameterPreservation.Matches(p, p.Replace("3333", "3334"), true));
        }
        [Fact] public void DiagnosticReportsBoundedParameterIdsWithoutValues()
        {
            Assert.Equal("-1019000", InlineAccessoryParameterPreservation.ChangedIds(Before, After));
            Assert.Equal("-1019000,1", InlineAccessoryParameterPreservation.ChangedIds(Before, After.Replace("retain", "secret")));
            Assert.Equal("unavailable", InlineAccessoryParameterPreservation.ChangedIds("[", After));
        }
    }
}
