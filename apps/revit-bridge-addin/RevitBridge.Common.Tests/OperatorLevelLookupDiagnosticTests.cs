using System;
using System.Linq;
using RevitBridge.Common;
using Xunit;

namespace RevitBridge.Common.Tests
{
    public class OperatorLevelLookupDiagnosticTests
    {
        [Fact]
        public void SuppliedButUnresolvedNameReturnsActualExactNamesInsteadOfMissingInputError()
        {
            var error = OperatorLevelLookupDiagnostic.Describe(null, "Level 2", new[] { "L4", "L2", "L1" });
            Assert.Contains("could not resolve levelName", error);
            Assert.Contains("Level 2", error);
            Assert.Contains("Available exact level names: \"L1\", \"L2\", \"L4\"", error);
            Assert.DoesNotContain("requires levelId or levelName", error);
        }

        [Fact]
        public void MissingSelectorAndInvalidIdRemainDistinctAndNoAliasIsInvented()
        {
            Assert.Contains("requires levelId or levelName", OperatorLevelLookupDiagnostic.Describe(null, null, Array.Empty<string>()));
            Assert.Contains("could not resolve levelId 99", OperatorLevelLookupDiagnostic.Describe(99, "L2", new[] { "Level Two" }));
            Assert.Contains("No short level names", OperatorLevelLookupDiagnostic.Describe(null, "L2", Array.Empty<string>()));
        }

        [Fact]
        public void DiagnosticBoundsDoNotAdvertiseTruncatedNamesAsExactSelectors()
        {
            var error = OperatorLevelLookupDiagnostic.Describe(null, new string('x', 5000),
                Enumerable.Range(0, 50).Select(n => "Level " + n.ToString("D2")).Concat(new[] { new string('z', 5000) }));
            Assert.True(error.Length < 1000);
            Assert.Contains("additional names omitted", error);
            Assert.DoesNotContain("zzz", error);
            Assert.Contains("Level 00", error);
            Assert.DoesNotContain("Level 49", error);
        }
    }
}
