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
        public void Tag_size_calibration_replaces_estimate_then_keeps_largest_measured_footprint()
        {
            var calibration = new TagSizeCalibration(4.8, 1.44);

            Assert.True(calibration.Observe(3.6, 2.0));
            Assert.True(calibration.IsCalibrated);
            Assert.Equal(3.6, calibration.Width, 6);
            Assert.Equal(2.0, calibration.Height, 6);

            Assert.True(calibration.Observe(4.1, 1.8));
            Assert.Equal(4.1, calibration.Width, 6);
            Assert.Equal(2.0, calibration.Height, 6);
        }

        [Fact]
        public void Tag_size_calibration_ignores_non_finite_or_non_positive_measurements()
        {
            var calibration = new TagSizeCalibration(4.8, 1.44);

            Assert.False(calibration.Observe(double.NaN, 2.0));
            Assert.False(calibration.Observe(3.0, double.PositiveInfinity));
            Assert.False(calibration.Observe(0, 2.0));
            Assert.False(calibration.IsCalibrated);
            Assert.Equal(4.8, calibration.Width, 6);
            Assert.Equal(1.44, calibration.Height, 6);
        }

        [Fact]
        public void Candidate_probe_policy_keeps_every_predicted_clear_candidate_and_caps_colliding_probes()
        {
            var candidates = Enumerable.Range(1, 12).Select(index => new TagPlacementCandidate
            {
                HeadX = index,
                HeadY = 0,
                Bounds = Rect(index, 0, index + 1, 1),
                CollisionCount = index <= 3 ? 0 : 1
            }).ToList();

            var selected = TagCandidateProbePolicy.Select(candidates, 12, 4);

            Assert.Equal(new[] { 1d, 2d, 3d, 4d, 5d, 6d, 7d }, selected.Select(candidate => candidate.HeadX));
        }

        [Fact]
        public void Candidate_probe_policy_honors_the_existing_attempt_bound()
        {
            var candidates = Enumerable.Range(1, 10).Select(index => new TagPlacementCandidate
            {
                HeadX = index,
                HeadY = 0,
                Bounds = Rect(index, 0, index + 1, 1),
                CollisionCount = index == 5 ? 0 : 1
            }).ToList();

            var selected = TagCandidateProbePolicy.Select(candidates, 4, 2);

            Assert.Equal(new[] { 1d, 2d }, selected.Select(candidate => candidate.HeadX));
        }

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
            Assert.InRange(ranked.Count, 1, 180);
            Assert.Equal(ranked.Count, ranked.Select(x => (x.HeadX, x.HeadY)).Distinct().Count());
        }

        [Fact]
        public void EscapesDenseNearFieldWithBoundedFarCandidate()
        {
            var target = Rect(-0.5, -0.5, 0.5, 0.5);
            var denseNearField = Rect(-3.4, -3.4, 3.4, 3.4);
            var candidate = TagPlacementPlanner.RankCandidates(new TagPlacementRequest
            {
                Target = target,
                Obstacles = new[] { target, denseNearField },
                TagWidth = 1,
                TagHeight = 1,
                Clearance = 0.1,
                Profile = "mep",
                MaxCandidates = 128
            }).First();
            Assert.True(candidate.CollisionFree);
            Assert.True(System.Math.Abs(candidate.HeadX) > 3.4 || System.Math.Abs(candidate.HeadY) > 3.4);
        }

        [Fact]
        public void CompleteBoundedSearchIncludesEveryLaneDistanceAndDirection()
        {
            var ranked = TagPlacementPlanner.RankCandidates(new TagPlacementRequest
            {
                Target = Rect(-0.5, -0.5, 0.5, 0.5),
                Obstacles = Array.Empty<TagRect2>(),
                TagWidth = 1,
                TagHeight = 1,
                Clearance = 0,
                Profile = "mep",
                MaxCandidates = 180
            });

            Assert.Equal(176, ranked.Count);
            Assert.Equal(ranked.Count, ranked.Select(x => (x.HeadX, x.HeadY)).Distinct().Count());
            Assert.True(ranked.Max(x => Math.Abs(x.HeadX)) >= 4.75);
            Assert.True(ranked.Max(x => Math.Abs(x.HeadY)) >= 4.75);
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
