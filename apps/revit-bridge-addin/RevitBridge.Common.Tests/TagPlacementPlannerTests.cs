using System;
using System.Collections.Generic;
using System.Linq;
using RevitBridge.Common.Annotation;
using Xunit;

namespace RevitBridge.Common.Tests
{
    public sealed class TagPlacementPlannerTests
    {
        [Fact]
        public void PlacesTagOutsideTargetFootprint()
        {
            var target = Rect(-0.5, -0.5, 0.5, 0.5);
            var candidate = Plan(target, new[] { target }).First();
            Assert.True(candidate.CollisionFree);
            Assert.False(candidate.Bounds.Intersects(target));
            Assert.Equal("right", candidate.Side);
        }

        [Fact]
        public void SelectsAlternateSideWhenPreferredSideIsBlocked()
        {
            var target = Rect(-0.5, -0.5, 0.5, 0.5);
            var rightBlocker = Rect(0.9, -2, 4, 2);
            var candidate = Plan(target, new[] { target, rightBlocker }).First();
            Assert.True(candidate.CollisionFree);
            Assert.NotEqual("right", candidate.Side);
        }

        [Fact]
        public void UsesDeterministicLanesToAvoidPriorTags()
        {
            var target = Rect(-0.5, -0.5, 0.5, 0.5);
            var first = Plan(target, new[] { target }).First();
            var second = Plan(target, new[] { target, first.Bounds }).First();
            Assert.True(second.CollisionFree);
            Assert.NotEqual((first.HeadX, first.HeadY), (second.HeadX, second.HeadY));
        }

        [Fact]
        public void ReportsLeastBadCandidateWhenEverySideIsBlocked()
        {
            var target = Rect(-0.5, -0.5, 0.5, 0.5);
            var surrounding = Rect(-20, -20, 20, 20);
            var candidate = Plan(target, new[] { target, surrounding }).First();
            Assert.False(candidate.CollisionFree);
            Assert.True(candidate.CollisionCount > 0);
        }

        [Fact]
        public void ExpandsOutwardWhenNearLanesAreBlocked()
        {
            var target = Rect(-0.5, -0.5, 0.5, 0.5);
            var nearRight = Rect(0.6, -4, 2.0, 4);
            var candidate = TagPlacementPlanner.RankCandidates(new TagPlacementRequest
            {
                Target = target,
                Obstacles = new[] { target, nearRight },
                TagWidth = 1,
                TagHeight = 0.5,
                Clearance = 0.1,
                Profile = "mep",
                MaxCandidates = 64
            }).First();
            Assert.True(candidate.CollisionFree);
            Assert.True(candidate.HeadX > 2.0);
        }

        [Fact]
        public void DisciplineProfilesChangeStablePreference()
        {
            var target = Rect(-0.5, -0.5, 0.5, 0.5);
            Assert.Equal("right", Plan(target, new[] { target }, "mep").First().Side);
            Assert.Equal("top", Plan(target, new[] { target }, "architectural").First().Side);
            Assert.Equal("right", Plan(target, new[] { target }, "electrical").First().Side);
        }

        [Fact]
        public void RejectsInvalidDimensionsAndBoundsCandidateCount()
        {
            Assert.Throws<ArgumentOutOfRangeException>(() => TagPlacementPlanner.RankCandidates(new TagPlacementRequest
            {
                Target = Rect(0, 0, 1, 1), TagWidth = double.NaN, TagHeight = 1, Clearance = 0
            }));
            var ranked = TagPlacementPlanner.RankCandidates(new TagPlacementRequest
            {
                Target = Rect(0, 0, 1, 1), TagWidth = 1, TagHeight = 1, Clearance = 0.1, MaxCandidates = 1000
            });
            Assert.InRange(ranked.Count, 1, 64);
        }

        private static IReadOnlyList<TagPlacementCandidate> Plan(TagRect2 target, IReadOnlyList<TagRect2> obstacles, string profile = "mep") =>
            TagPlacementPlanner.RankCandidates(new TagPlacementRequest
            {
                Target = target,
                Obstacles = obstacles,
                TagWidth = 2,
                TagHeight = 0.6,
                Clearance = 0.2,
                Profile = profile,
                MaxCandidates = 20
            });

        private static TagRect2 Rect(double minX, double minY, double maxX, double maxY) => new TagRect2(minX, minY, maxX, maxY);
    }
}
