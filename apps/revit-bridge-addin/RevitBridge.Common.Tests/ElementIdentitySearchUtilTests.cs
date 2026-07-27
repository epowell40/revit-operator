using System.Collections.Generic;
using RevitBridge.Common;
using Xunit;

namespace RevitBridge.Common.Tests
{
    public sealed class ElementIdentitySearchUtilTests
    {
        [Fact]
        public void MatchesExactPhraseAcrossFamilyIdentity()
        {
            var result = ElementIdentitySearchUtil.Match(Fields(family: "LW_Shock Absorber"), new[] { "shock absorber" });

            Assert.True(result.IsMatch);
            Assert.Equal(1.0, result.Score);
            Assert.Contains("familyName", result.MatchedFields);
        }

        [Fact]
        public void ExactPhraseRequiresTokenBoundariesAndContiguousTokens()
        {
            Assert.False(ElementIdentitySearchUtil.Match(Fields(family: "Stair Support"), new[] { "air" }).IsMatch);
            Assert.True(ElementIdentitySearchUtil.Match(Fields(family: "Air Handling Unit"), new[] { "air handling" }).IsMatch);
            Assert.True(ElementIdentitySearchUtil.Match(
                new[] { new ElementIdentityField { Name = "mark", Value = "SA-17" } },
                new[] { "SA-17" }).IsMatch);
        }

        [Fact]
        public void MatchesOrdinaryVocabularyByBoundedTokenOverlap()
        {
            var result = ElementIdentitySearchUtil.Match(Fields(family: "LW_Shock Absorber"), new[] { "shock arrestors" });

            Assert.True(result.IsMatch);
            Assert.Equal(0.5, result.Score);
            Assert.Equal(new[] { "shock" }, result.MatchedTokens);
            Assert.Contains("familyName", result.MatchedFields);
        }

        [Fact]
        public void RequiresHalfOfThreeOrMoreMeaningfulTokens()
        {
            var result = ElementIdentitySearchUtil.Match(Fields(family: "Acme Air Handling Unit"), new[] { "air handling unit" });
            var falsePositive = ElementIdentitySearchUtil.Match(Fields(family: "Air Separator"), new[] { "air handling unit" });

            Assert.True(result.IsMatch);
            Assert.False(falsePositive.IsMatch);
        }

        [Fact]
        public void SearchesNameFamilyTypeCategoryAndMarkWithoutParameters()
        {
            var result = ElementIdentitySearchUtil.Match(
                new[]
                {
                    new ElementIdentityField { Name = "name", Value = "Standard" },
                    new ElementIdentityField { Name = "familyName", Value = "Example" },
                    new ElementIdentityField { Name = "typeName", Value = "Type A" },
                    new ElementIdentityField { Name = "category", Value = "Pipe Fittings" },
                    new ElementIdentityField { Name = "mark", Value = "SA-17" }
                },
                new[] { "SA-17" });

            Assert.True(result.IsMatch);
            Assert.Contains("mark", result.MatchedFields);
        }

        [Fact]
        public void FailsClosedWhenTermsContainOnlyQueryScaffolding()
        {
            var result = ElementIdentitySearchUtil.Match(Fields(family: "Anything"), new[] { "find this in the project" });

            Assert.False(result.IsMatch);
            Assert.Empty(result.MatchedTokens);
        }

        [Fact]
        public void BuildsBoundedPhraseAcronymsWithoutFixtureSpecificVocabulary()
        {
            Assert.Equal(new[] { "sa", "ahu" }, ElementIdentitySearchUtil.BuildAcronyms(new[] { "shock arrestors", "air handling units", "device" }));
        }

        [Theory]
        [InlineData("DESIG.", true)]
        [InlineData("Mark", true)]
        [InlineData("Asset ID", true)]
        [InlineData("Status", false)]
        [InlineData("Comments", false)]
        public void AcronymExpansionRequiresAnIdentityBearingParameterName(string parameterName, bool expected)
        {
            Assert.Equal(expected, ElementIdentitySearchUtil.IsIdentityBearingParameterName(parameterName));
        }

        [Fact]
        public void ExpansionCandidatesMustRetainEveryIndependentIdentityFilter()
        {
            Assert.True(ElementIdentitySearchUtil.MatchesIndependentIdentityFilters(
                "Standard Device", "SA-17", "Type A", "Shock Absorber",
                "Device", "SA-", "Type A", "Shock"));
            Assert.False(ElementIdentitySearchUtil.MatchesIndependentIdentityFilters("Other", "SA-17", "Type A", "Shock Absorber", "Device", "SA-", "Type A", "Shock"));
            Assert.False(ElementIdentitySearchUtil.MatchesIndependentIdentityFilters("Standard Device", "X-17", "Type A", "Shock Absorber", "Device", "SA-", "Type A", "Shock"));
            Assert.False(ElementIdentitySearchUtil.MatchesIndependentIdentityFilters("Standard Device", "SA-17", "Type B", "Shock Absorber", "Device", "SA-", "Type A", "Shock"));
            Assert.False(ElementIdentitySearchUtil.MatchesIndependentIdentityFilters("Standard Device", "SA-17", "Type A", "Other Family", "Device", "SA-", "Type A", "Shock"));
        }

        [Fact]
        public void DocumentDiscoveryRequiresAResolvedCategoryOrSearchPredicate()
        {
            Assert.False(ElementIdentitySearchUtil.HasBoundedDocumentPredicate(0, new string?[] { null, " ", "---" }));
            Assert.True(ElementIdentitySearchUtil.HasBoundedDocumentPredicate(1, System.Array.Empty<string?>()));
            Assert.True(ElementIdentitySearchUtil.HasBoundedDocumentPredicate(0, new[] { "shock arrestors" }));
        }

        private static IEnumerable<ElementIdentityField> Fields(string? family = null)
        {
            return new[]
            {
                new ElementIdentityField { Name = "name", Value = "Standard" },
                new ElementIdentityField { Name = "familyName", Value = family },
                new ElementIdentityField { Name = "typeName", Value = "Standard" },
                new ElementIdentityField { Name = "category", Value = "Pipe Fittings" },
                new ElementIdentityField { Name = "mark", Value = null }
            };
        }
    }
}
