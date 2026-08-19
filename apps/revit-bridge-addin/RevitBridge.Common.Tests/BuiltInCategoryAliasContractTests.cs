using RevitBridge.Common;
using Xunit;

namespace RevitBridge.Common.Tests
{
    public class BuiltInCategoryAliasContractTests
    {
        [Fact]
        public void ElementTypeResolutionReusesTheGeneralCategoryAliasVocabulary()
        {
            var resolved = BuiltInCategoryAliasVocabulary.TryResolve(
                "  Air Terminals  ",
                out var canonical);

            Assert.True(resolved);
            Assert.Equal("OST_DuctTerminal", canonical);
        }
    }
}
