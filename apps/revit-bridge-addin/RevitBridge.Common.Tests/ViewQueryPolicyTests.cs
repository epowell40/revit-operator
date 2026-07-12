using System;
using System.Collections.Generic;
using RevitBridge.Common;
using Xunit;

namespace RevitBridge.Common.Tests
{
    public class ViewQueryPolicyTests
    {
        private static readonly ViewQueryCandidate[] Views =
        {
            new ViewQueryCandidate { Id = 1, Name = "L4 - Power", ViewType = "FloorPlan", LevelName = "L4", Discipline = "Electrical" },
            new ViewQueryCandidate { Id = 2, Name = "L4 - Lighting", ViewType = "CeilingPlan", LevelName = "L4", Discipline = "Electrical" },
            new ViewQueryCandidate { Id = 3, Name = "L3 - Power", ViewType = "FloorPlan", LevelName = "L3", Discipline = "Electrical" },
            new ViewQueryCandidate { Id = 4, Name = "L4 - HVAC", ViewType = "FloorPlan", LevelName = "L4", Discipline = "Mechanical" },
            new ViewQueryCandidate { Id = 5, Name = "Power Template", ViewType = "FloorPlan", LevelName = "L4", Discipline = "Electrical", IsTemplate = true }
        };

        [Fact]
        public void ExactLevelAndSemanticGroupArePredicatePushedTogether()
        {
            var result = ViewQueryPolicy.Apply(Views, new ViewQueryFilter { LevelNames = new[] { "L4" }, SemanticGroups = new[] { "power" } });
            Assert.Single(result.Views);
            Assert.Equal(1, result.Views[0].Id);
            Assert.Contains("level_names_exact", result.AppliedFilters);
            Assert.Contains("semantic_groups", result.AppliedFilters);
        }

        [Fact]
        public void UnknownScopeValuesReturnEmptyWithoutBroadening()
        {
            var result = ViewQueryPolicy.Apply(Views, new ViewQueryFilter { LevelNames = new[] { "L99" }, Disciplines = new[] { "Electrical" } });
            Assert.Empty(result.Views);
            Assert.Equal(0, result.Total);
        }

        [Fact]
        public void PagingIsDeterministicAndReportsTruncation()
        {
            var result = ViewQueryPolicy.Apply(Views, new ViewQueryFilter { Disciplines = new[] { "Electrical" }, Limit = 2 });
            Assert.Equal(3, result.Total);
            Assert.Equal(new long[] { 3, 2 }, new[] { result.Views[0].Id, result.Views[1].Id });
            Assert.True(result.Truncated);
        }

        [Fact]
        public void UnsupportedSemanticGroupFailsClosed()
        {
            Assert.Throws<ArgumentException>(() => ViewQueryPolicy.Apply(Views, new ViewQueryFilter { SemanticGroups = new[] { "imaginary" } }));
        }

        [Fact]
        public void ExplicitIdsDoNotWidenToOtherViews()
        {
            var result = ViewQueryPolicy.Apply(Views, new ViewQueryFilter { ViewIds = new long[] { 4 } });
            Assert.Single(result.Views);
            Assert.Equal(4, result.Views[0].Id);
        }

        [Fact]
        public void ExactViewNameDoesNotUseContainsMatching()
        {
            var result = ViewQueryPolicy.Apply(Views, new ViewQueryFilter { ViewNames = new[] { "L4 - Power" } });
            Assert.Single(result.Views);
            Assert.Equal(1, result.Views[0].Id);
        }
    }
}
