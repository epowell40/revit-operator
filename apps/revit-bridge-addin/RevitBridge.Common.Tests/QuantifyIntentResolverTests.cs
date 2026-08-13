using System;
using RevitBridge.Common.Semantic;
using Xunit;

namespace RevitBridge.Common.Tests
{
    public sealed class QuantifyIntentResolverTests
    {
        [Theory]
        [InlineData("count", "count")]
        [InlineData("count_and_list", "count_and_list")]
        [InlineData("Project-wide Air Terminal instance count grouped by family and type", "count")]
        [InlineData("How many air terminals are there?", "count")]
        [InlineData("list the matching elements", "list")]
        [InlineData("count and list matching instances", "count_and_list")]
        public void ResolvesCanonicalAndClearNaturalLanguageIntents(string input, string expected)
        {
            Assert.Equal(expected, QuantifyIntentResolver.Resolve(input));
        }

        [Fact]
        public void RejectsAmbiguousIntent()
        {
            Assert.Throws<ArgumentException>(() => QuantifyIntentResolver.Resolve("analyze air terminals"));
        }
    }
}
