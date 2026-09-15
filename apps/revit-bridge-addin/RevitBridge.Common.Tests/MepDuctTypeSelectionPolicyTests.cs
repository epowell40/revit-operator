using System.Collections.Generic;
using RevitBridge.Common;
using Xunit;

namespace RevitBridge.Common.Tests
{
    public class MepDuctTypeSelectionPolicyTests
    {
        private static readonly List<MepDuctTypeCandidate> Candidates = new List<MepDuctTypeCandidate>
        {
            new MepDuctTypeCandidate { Id = 30, Name = "Default", FamilyName = "Oval Duct", Shape = "oval" },
            new MepDuctTypeCandidate { Id = 10, Name = "Default", FamilyName = "Rectangular Duct", Shape = "rectangular" },
            new MepDuctTypeCandidate { Id = 20, Name = "Default", FamilyName = "Round Duct", Shape = "round" }
        };

        [Fact]
        public void ResolveFailsClosedForDuplicateExactNames()
        {
            var result = MepDuctTypeSelectionPolicy.Resolve(Candidates, null, "Default");

            Assert.Null(result.Selected);
            Assert.True(result.Ambiguous);
            Assert.Equal(new long[] { 10, 20, 30 }, new[] { result.Candidates[0].Id, result.Candidates[1].Id, result.Candidates[2].Id });
        }

        [Fact]
        public void ResolveAcceptsExplicitNativeId()
        {
            var result = MepDuctTypeSelectionPolicy.Resolve(Candidates, 20, "Default");

            Assert.NotNull(result.Selected);
            Assert.Equal(20, result.Selected!.Id);
            Assert.False(result.Ambiguous);
        }

        [Fact]
        public void ResolveAcceptsUniqueFamilyName()
        {
            var result = MepDuctTypeSelectionPolicy.Resolve(Candidates, null, "Round Duct");

            Assert.NotNull(result.Selected);
            Assert.Equal(20, result.Selected!.Id);
        }

        [Fact]
        public void ResolveDoesNotFallBackWhenExplicitIdIsMissing()
        {
            var result = MepDuctTypeSelectionPolicy.Resolve(Candidates, 999, "Round Duct");

            Assert.Null(result.Selected);
            Assert.False(result.Ambiguous);
            Assert.Contains("999", result.Error);
        }

        [Fact]
        public void ResolveRequiresSelectionWhenSeveralTypesExistAndNoQueryWasGiven()
        {
            var result = MepDuctTypeSelectionPolicy.Resolve(Candidates, null, null);

            Assert.Null(result.Selected);
            Assert.True(result.Ambiguous);
        }

        [Fact]
        public void ResolveAllowsTheOnlyLoadedTypeWithoutAQuery()
        {
            var result = MepDuctTypeSelectionPolicy.Resolve(new[] { Candidates[0] }, null, null);

            Assert.NotNull(result.Selected);
            Assert.Equal(30, result.Selected!.Id);
        }

        [Theory]
        [InlineData("round", 20)]
        [InlineData("rectangular", 10)]
        [InlineData("oval", 30)]
        public void RequestedNativeShapeResolvesOnlyCompatibleType(string shape, long expected)
        {
            var result = MepDuctTypeSelectionPolicy.Resolve(Candidates, null, "Default", shape);
            Assert.Equal(expected, result.Selected!.Id);
        }

        [Fact]
        public void IncompatibleExplicitIdentityNeverFallsBackAndReturnsCompatibleCandidates()
        {
            var result = MepDuctTypeSelectionPolicy.Resolve(Candidates, 20, "Default", "rectangular");
            Assert.Null(result.Selected);
            Assert.Single(result.Candidates);
            Assert.Equal(10, result.Candidates[0].Id);
            Assert.Contains("round", result.Error);
            Assert.Contains("rectangular", result.Error);
            Assert.Contains("no transaction", result.Error);
            Assert.Null(MepDuctTypeSelectionPolicy.Resolve(Candidates, null, "Round Duct", "rectangular").Selected);
            Assert.Null(MepDuctTypeSelectionPolicy.Resolve(Candidates, 999, "Default", "rectangular").Selected);
        }

        [Fact]
        public void UnknownProfilesAndAmbiguousCompatibleTypesRemainUnresolved()
        {
            var unknown = new MepDuctTypeCandidate { Id = 40, Name = "Rectangular sounding name", FamilyName = "Rectangular Duct" };
            Assert.Null(MepDuctTypeSelectionPolicy.Resolve(new[] { unknown }, null, null, "rectangular").Selected);
            var sameShape = new MepDuctTypeCandidate { Id = 50, Name = "Default", Shape = "rectangular" };
            var result = MepDuctTypeSelectionPolicy.Resolve(new[] { Candidates[0], sameShape, Candidates[1], Candidates[2] }, null, "Default", "rectangular");
            Assert.Null(result.Selected);
            Assert.True(result.Ambiguous);
            Assert.Equal(2, result.Candidates.Count);
            Assert.Null(MepDuctTypeSelectionPolicy.Resolve(Candidates, null, null, "square").Selected);
        }
    }
}
