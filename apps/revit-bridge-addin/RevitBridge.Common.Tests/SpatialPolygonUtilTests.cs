using System.Collections.Generic;
using RevitBridge.Common;
using Xunit;

namespace RevitBridge.Common.Tests
{
    public class SpatialPolygonUtilTests
    {
        [Fact]
        public void Contains_Uses_Even_Odd_Rule_For_Holes()
        {
            var loops = new List<IReadOnlyList<SpatialPoint2>>
            {
                Square(0, 0, 10, 10),
                Square(4, 4, 6, 6)
            };

            Assert.True(SpatialPolygonUtil.Contains(2, 2, loops));
            Assert.False(SpatialPolygonUtil.Contains(5, 5, loops));
            Assert.False(SpatialPolygonUtil.Contains(12, 5, loops));
        }

        [Fact]
        public void DistanceToBoundary_Returns_Closest_Segment_Distance()
        {
            var loops = new List<IReadOnlyList<SpatialPoint2>>
            {
                Square(0, 0, 10, 10)
            };

            Assert.Equal(2, SpatialPolygonUtil.DistanceToBoundary(12, 5, loops), 6);
            Assert.Equal(5, SpatialPolygonUtil.DistanceToBoundary(5, 5, loops), 6);
        }

        [Fact]
        public void Classify_Leaves_Shared_Edges_And_Corners_As_Boundary()
        {
            var left = new List<IReadOnlyList<SpatialPoint2>> { Square(0, 0, 5, 10) };
            var right = new List<IReadOnlyList<SpatialPoint2>> { Square(5, 0, 10, 10) };

            Assert.Equal(SpatialPointRelation.Boundary, SpatialPolygonUtil.Classify(5, 5, left));
            Assert.Equal(SpatialPointRelation.Boundary, SpatialPolygonUtil.Classify(5, 5, right));
            Assert.Equal(SpatialPointRelation.Boundary, SpatialPolygonUtil.Classify(0, 0, left));
        }

        [Fact]
        public void Classify_Leaves_Hole_Boundary_Unassigned()
        {
            var loops = new List<IReadOnlyList<SpatialPoint2>>
            {
                Square(0, 0, 10, 10),
                Square(4, 4, 6, 6)
            };

            Assert.Equal(SpatialPointRelation.Boundary, SpatialPolygonUtil.Classify(4, 5, loops));
            Assert.Equal(SpatialPointRelation.Outside, SpatialPolygonUtil.Classify(5, 5, loops));
        }

        [Fact]
        public void Tessellated_Curved_Edge_Preserves_Area_Beyond_Its_Chord()
        {
            // The upper edge approximates a semicircular arc. A start-point-only
            // chord would run from (10,0) to (0,0) and lose this entire cap.
            var arcRoom = new List<IReadOnlyList<SpatialPoint2>>
            {
                new[]
                {
                    new SpatialPoint2(0, 0),
                    new SpatialPoint2(10, 0),
                    new SpatialPoint2(9.24, 3.83),
                    new SpatialPoint2(7.07, 7.07),
                    new SpatialPoint2(3.83, 9.24),
                    new SpatialPoint2(0, 10)
                }
            };

            Assert.Equal(SpatialPointRelation.Inside, SpatialPolygonUtil.Classify(5, 4, arcRoom));
        }

        [Fact]
        public void Candidate_Identity_Does_Not_Collapse_Distinct_Same_Label_Rooms()
        {
            var first = SpatialCandidateIdentityUtil.Build("Room", "linked", 77, 5001, "77:5001");
            var second = SpatialCandidateIdentityUtil.Build("Room", "linked", 77, 5002, "77:5002");

            Assert.NotEqual(first, second);
        }

        [Fact]
        public void Phase_Map_Selects_Only_The_Effective_Host_Phase()
        {
            var map = new[]
            {
                new KeyValuePair<long, long>(1, 101),
                new KeyValuePair<long, long>(2, 202)
            };

            Assert.Equal(202, SpatialPhaseMapUtil.ResolveLinkedPhaseId(2, map));
            Assert.Null(SpatialPhaseMapUtil.ResolveLinkedPhaseId(3, map));
        }

        [Fact]
        public void Vertical_Range_Fails_Closed_For_Stacked_Or_Unknown_Context()
        {
            Assert.True(SpatialVerticalRangeUtil.Contains(9, 0, 10));
            Assert.False(SpatialVerticalRangeUtil.Contains(19, 0, 10));
            Assert.False(SpatialVerticalRangeUtil.Contains(9, null, 10));
            Assert.False(SpatialVerticalRangeUtil.Contains(9, 0, null));
        }

        [Fact]
        public void Candidate_Source_Flags_And_Geometric_Room_Filter_Are_Enforced()
        {
            Assert.False(SpatialCandidateFilterUtil.SourceIsEnabled("Room", "host", false, true, true));
            Assert.False(SpatialCandidateFilterUtil.SourceIsEnabled("Space", "host", true, false, true));
            Assert.False(SpatialCandidateFilterUtil.SourceIsEnabled("Room", "linked", true, true, false));
            Assert.True(SpatialCandidateFilterUtil.MatchesRequested("101", "MECHANICAL", "101", "mech"));
            Assert.False(SpatialCandidateFilterUtil.MatchesRequested("101", "MECHANICAL", "202", ""));
        }

        [Fact]
        public void Missing_Geometry_Uses_Only_Explicit_Association_Evidence()
        {
            Assert.Equal("unresolved", SpatialResolutionDecisionUtil.WithoutGeometryStatus(0));
            Assert.Equal("resolved", SpatialResolutionDecisionUtil.WithoutGeometryStatus(1));
            Assert.Equal("ambiguous", SpatialResolutionDecisionUtil.WithoutGeometryStatus(2));
        }

        [Theory]
        [InlineData("Existing", true)]
        [InlineData("New", true)]
        [InlineData("Demolished", false)]
        [InlineData("Temporary", false)]
        [InlineData("None", false)]
        [InlineData("Future", false)]
        [InlineData("", false)]
        public void Target_Element_Must_Be_Present_In_The_Effective_Host_Phase(
            string phaseStatus,
            bool expected)
        {
            // The target lifecycle gate is identical whether the containing
            // room evidence is host-native or transformed from a linked model.
            Assert.Equal(expected, SpatialElementLifecycleUtil.IsPresentInEffectivePhase(phaseStatus));
        }

        [Fact]
        public void Proximity_Fails_Closed_When_Either_Point_Is_Unavailable()
        {
            Assert.True(SpatialLocationEvidenceUtil.CanEvaluateProximity(true, true));
            Assert.False(SpatialLocationEvidenceUtil.CanEvaluateProximity(false, true));
            Assert.False(SpatialLocationEvidenceUtil.CanEvaluateProximity(true, false));
            Assert.False(SpatialLocationEvidenceUtil.CanEvaluateProximity(false, false));
        }

        [Fact]
        public void Placement_Suggestions_Require_Both_A_Supported_Host_And_A_Factual_Point()
        {
            Assert.True(SpatialLocationEvidenceUtil.CanSuggestPlacement(true, true));
            Assert.False(SpatialLocationEvidenceUtil.CanSuggestPlacement(true, false));
            Assert.False(SpatialLocationEvidenceUtil.CanSuggestPlacement(false, true));
            Assert.False(SpatialLocationEvidenceUtil.CanSuggestPlacement(false, false));
        }

        private static IReadOnlyList<SpatialPoint2> Square(
            double minX,
            double minY,
            double maxX,
            double maxY)
        {
            return new[]
            {
                new SpatialPoint2(minX, minY),
                new SpatialPoint2(maxX, minY),
                new SpatialPoint2(maxX, maxY),
                new SpatialPoint2(minX, maxY)
            };
        }
    }
}
