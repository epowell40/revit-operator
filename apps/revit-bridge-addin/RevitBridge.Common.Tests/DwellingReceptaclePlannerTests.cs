using System.Collections.Generic;
using System.Linq;
using System.Text.Json;
using RevitBridge.Common.LowVoltage.Core.Geometry;
using RevitBridge.Common.LowVoltage.Skills.DwellingReceptacles;
using Xunit;

namespace RevitBridge.Common.Tests
{
    public sealed class DwellingReceptaclePlannerTests
    {
        [Fact]
        public void EmptyTwentyFourFootWallProducesTwoEvenlySpacedPlacements()
        {
            var plan = DwellingReceptaclePlanner.Plan(Input(Wall("south", 0, 24)));

            Assert.Equal("ready", plan.Status);
            Assert.Equal(new[] { 6.0, 18.0 }, plan.ProposedPlacements.Select(x => x.ChainageFt).ToArray());
            Assert.All(plan.ProposedPlacements, x => Assert.False(x.RequiresApply));
            Assert.All(plan.CoverageChecks, x => Assert.True(x.Passes));
            Assert.False(plan.InvokedTools);
            Assert.Contains("not a jurisdictional code-compliance", plan.ComplianceDisclaimer);
        }

        [Fact]
        public void DoorOpeningSplitsWallAndShortFragmentsAreExcluded()
        {
            var wall = Wall("north", 0, 20);
            wall.ExcludedIntervals.Add(new DwellingReceptacleExcludedInterval { StartChainageFt = 8, EndChainageFt = 12, Kind = "door" });

            var plan = DwellingReceptaclePlanner.Plan(Input(wall));

            Assert.Equal(new[] { 4.0, 16.0 }, plan.ProposedPlacements.Select(x => x.ChainageFt).ToArray());
            Assert.Equal(2, plan.CoverageChecks.Count);
            Assert.All(plan.CoverageChecks, x => Assert.True(x.Passes));
        }

        [Fact]
        public void MultipleOverlappingOpeningsAreMergedAndEveryRemainingIntervalPasses()
        {
            var wall = Wall("north", 0, 30);
            wall.ExcludedIntervals.Add(new DwellingReceptacleExcludedInterval { StartChainageFt = 5, EndChainageFt = 9, Kind = "door" });
            wall.ExcludedIntervals.Add(new DwellingReceptacleExcludedInterval { StartChainageFt = 8, EndChainageFt = 11, Kind = "door" });
            wall.ExcludedIntervals.Add(new DwellingReceptacleExcludedInterval { StartChainageFt = 18, EndChainageFt = 22, Kind = "window" });

            var plan = DwellingReceptaclePlanner.Plan(Input(wall));

            Assert.Equal("ready", plan.Status);
            Assert.Equal(3, plan.CoverageChecks.Count);
            Assert.All(plan.CoverageChecks, x => Assert.True(x.Passes));
            Assert.DoesNotContain(plan.ProposedPlacements, x => (x.ChainageFt > 5 && x.ChainageFt < 11) || (x.ChainageFt > 18 && x.ChainageFt < 22));
        }

        [Fact]
        public void DiagonalAndCornerSegmentsPreserveWorldCoordinatesAndMountingElevation()
        {
            var diagonal = new DwellingReceptacleWallSpace
            {
                WallSpaceId = "diagonal",
                HostScopedId = "link:1362762:wall-diagonal",
                Start = new Point3 { X = 0, Y = 0, Z = 32 },
                End = new Point3 { X = 12, Y = 12, Z = 32 }
            };
            var corner = new DwellingReceptacleWallSpace
            {
                WallSpaceId = "corner-return",
                HostScopedId = "link:1362762:wall-corner",
                Start = new Point3 { X = 12, Y = 12, Z = 32 },
                End = new Point3 { X = 12, Y = 20, Z = 32 }
            };

            var plan = DwellingReceptaclePlanner.Plan(Input(diagonal, corner));

            Assert.Equal("ready", plan.Status);
            Assert.All(plan.ProposedPlacements, x => Assert.Equal(33.5, x.Point.Z, 6));
            Assert.Contains(plan.ProposedPlacements, x => x.WallSpaceId == "diagonal" && x.Point.X > 0 && x.Point.Y > 0);
            Assert.All(plan.CoverageChecks, x => Assert.True(x.Passes));
        }

        [Fact]
        public void ExistingReceptacleSuppressesDuplicateAndCanSatisfyWall()
        {
            var input = Input(Wall("east", 0, 10));
            input.ExistingReceptacles.Add(new DwellingExistingReceptacle { ElementId = 42, WallSpaceId = "east", ChainageFt = 5 });

            var plan = DwellingReceptaclePlanner.Plan(input);

            Assert.Empty(plan.ProposedPlacements);
            Assert.Single(plan.CoverageChecks);
            Assert.True(plan.CoverageChecks[0].Passes);
        }

        [Fact]
        public void SpecialConditionFailsClosedWithoutPlacements()
        {
            var input = Input(Wall("counter", 0, 14));
            input.RoomClassifications = new List<string> { "kitchen", "similar_dwelling_area" };

            var plan = DwellingReceptaclePlanner.Plan(input);

            Assert.Equal("manual_review", plan.Status);
            Assert.Empty(plan.ProposedPlacements);
            Assert.Contains(plan.ManualReviews, x => x.Code == "special_condition_scope");
        }

        [Fact]
        public void FloorReceptacleScopeFailsClosedEvenWithSupportedRoomClassification()
        {
            var input = Input(Wall("south", 0, 20));
            input.RoomClassifications.Add("floor_receptacle");

            var plan = DwellingReceptaclePlanner.Plan(input);

            Assert.Equal("manual_review", plan.Status);
            Assert.Empty(plan.ProposedPlacements);
            Assert.Contains(plan.ManualReviews, x => x.Code == "special_condition_scope");
        }

        [Fact]
        public void UnclassifiedRoomFailsClosedWithoutPlacements()
        {
            var input = Input(Wall("west", 0, 14));
            input.RoomClassifications.Clear();

            var plan = DwellingReceptaclePlanner.Plan(input);

            Assert.Equal("manual_review", plan.Status);
            Assert.Empty(plan.ProposedPlacements);
            Assert.Contains(plan.ManualReviews, x => x.Code == "unclassified_room");
        }

        [Fact]
        public void TwoFootWallQualifiesAndShorterWallDoesNot()
        {
            var input = Input(Wall("two", 0, 2), Wall("short", 0, 1.99));

            var plan = DwellingReceptaclePlanner.Plan(input);

            Assert.Single(plan.ProposedPlacements);
            Assert.Equal("two", plan.ProposedPlacements[0].WallSpaceId);
            Assert.Contains(plan.ManualReviews, x => x.Code == "short_wall_space_excluded" && x.WallSpaceId == "short");
        }

        [Fact]
        public void PlannerIsDeterministicAndDoesNotAliasInput()
        {
            var input = Input(Wall("south", 0, 26));
            var first = DwellingReceptaclePlanner.Plan(input);
            var firstPoints = first.ProposedPlacements.Select(x => x.Point.X).ToArray();
            input.WallSpaces[0].End.X = 100;
            var secondInput = Input(Wall("south", 0, 26));
            var second = DwellingReceptaclePlanner.Plan(secondInput);

            Assert.Equal(first.ProposedPlacements.Select(x => x.ChainageFt), second.ProposedPlacements.Select(x => x.ChainageFt));
            Assert.Equal(firstPoints, first.ProposedPlacements.Select(x => x.Point.X).ToArray());
            Assert.All(first.ProposedPlacements, x => Assert.InRange(x.Point.X, 0, 26));
        }

        [Fact]
        public void ProfileRoundTripsEveryDecisionField()
        {
            var source = new DwellingReceptacleProfile();
            var json = DwellingReceptacleProfileSerializer.Serialize(source);
            var roundTrip = DwellingReceptacleProfileSerializer.Deserialize(json);

            Assert.Equal(source.ProfileId, roundTrip.ProfileId);
            Assert.Equal(source.Version, roundTrip.Version);
            Assert.Equal(source.ReferenceEdition, roundTrip.ReferenceEdition);
            Assert.Equal(source.ReferenceSections, roundTrip.ReferenceSections);
            Assert.Equal(source.MinimumWallSpaceWidthFt, roundTrip.MinimumWallSpaceWidthFt);
            Assert.Equal(source.MaximumFloorLineDistanceToReceptacleFt, roundTrip.MaximumFloorLineDistanceToReceptacleFt);
            Assert.Equal(source.MaximumReceptacleSpacingFt, roundTrip.MaximumReceptacleSpacingFt);
            Assert.Equal(source.DefaultMountingHeightAffFt, roundTrip.DefaultMountingHeightAffFt);
            Assert.Equal(source.DuplicateToleranceFt, roundTrip.DuplicateToleranceFt);
            Assert.Equal(source.OpeningClearanceFt, roundTrip.OpeningClearanceFt);
            Assert.Equal(source.PreferredDeviceFamilyIntent, roundTrip.PreferredDeviceFamilyIntent);
            Assert.Equal(source.CircuitPolicy, roundTrip.CircuitPolicy);
            Assert.Equal(source.ComplianceDisclaimer, roundTrip.ComplianceDisclaimer);
            Assert.Equal(source.SupportedRoomClassifications, roundTrip.SupportedRoomClassifications);
            Assert.Equal(source.ManualReviewClassifications, roundTrip.ManualReviewClassifications);
        }

        [Fact]
        public void ProfileRejectsUnsafeSpacingAndMissingDisclaimer()
        {
            var source = new DwellingReceptacleProfile();
            var unsafeSpacing = JsonSerializer.Deserialize<Dictionary<string, object>>(DwellingReceptacleProfileSerializer.Serialize(source))!;
            unsafeSpacing["MaximumReceptacleSpacingFt"] = 13.0;
            Assert.ThrowsAny<System.ArgumentException>(() => DwellingReceptacleProfileSerializer.Deserialize(JsonSerializer.Serialize(unsafeSpacing)));

            source.ComplianceDisclaimer = "Office standard.";
            Assert.ThrowsAny<System.ArgumentException>(() => DwellingReceptacleProfileSerializer.Serialize(source));
        }

        [Fact]
        public void AnalogPlannerMapsFullRoom405InventoryWithExactTypesAndSemanticDeltas()
        {
            var input = AnalogFixture();

            var plan = DwellingReceptacleAnalogPlanner.Plan(input);

            Assert.Equal("ready", plan.Status);
            Assert.False(plan.InvokedTools);
            Assert.Equal(14, plan.ProposedPlacements.Count);
            Assert.Equal(14, plan.ProposedPlacements.Select(x => x.TargetPoint.X.ToString("R") + "|" + x.TargetPoint.Y.ToString("R") + "|" + x.TargetPoint.Z.ToString("R")).Distinct().Count());
            Assert.Equal(new[] { 7, 4, 1, 2 }, new[]
            {
                plan.ProposedPlacements.Count(x => x.FamilyTypeKey == "Duplex Receptacle/Standard"),
                plan.ProposedPlacements.Count(x => x.FamilyTypeKey == "Duplex Receptacle/GFCI"),
                plan.ProposedPlacements.Count(x => x.FamilyTypeKey == "Duplex Receptacle/Counter Top"),
                plan.ProposedPlacements.Count(x => x.FamilyTypeKey == "High Voltage Receptacle/Standard")
            });
            Assert.All(plan.ProposedPlacements, x => Assert.NotEmpty(x.MappingRuleTrace));

            var kitchen = plan.ProposedPlacements.Single(x => x.SourceElementId == "405-gfci-kitchen-sink");
            var vanityLeft = plan.ProposedPlacements.Single(x => x.SourceElementId == "405-gfci-vanity-left");
            var vanityRight = plan.ProposedPlacements.Single(x => x.SourceElementId == "405-gfci-vanity-right");
            Assert.Equal("semantic_anchor", kitchen.MappingBasis);
            Assert.Equal(-28.4269, kitchen.TargetPoint.X, 4);
            Assert.Equal(-8.3542, kitchen.TargetPoint.Y, 4);
            Assert.Equal(-34.5567, vanityLeft.TargetPoint.X, 4);
            Assert.Equal(-39.2571, vanityRight.TargetPoint.X, 4);
            Assert.NotEqual(kitchen.TargetPoint.X - -2.0729, vanityLeft.TargetPoint.X - -6.9737);
            Assert.Equal("plumbing_fixtures|kitchen_sink|standard", kitchen.SourceAnchorSignature);
            Assert.Equal(kitchen.SourceAnchorSignature, kitchen.TargetAnchorSignature);
            Assert.Equal("host:403:kitchen-sink", kitchen.TargetHostScopedId);
            Assert.NotNull(kitchen.TargetHostAnchorScopedId);
        }

        [Fact]
        public void AnalogPlannerMapsGeneralWallsBySideAndNormalizedChainageAcrossUnequalFrames()
        {
            var input = AnalogFixture();
            var plan = DwellingReceptacleAnalogPlanner.Plan(input);

            var top = plan.ProposedPlacements.Single(x => x.SourceElementId == "405-standard-top");
            var right = plan.ProposedPlacements.Single(x => x.SourceElementId == "405-standard-right");
            var bottom = plan.ProposedPlacements.Single(x => x.SourceElementId == "405-standard-bottom");
            Assert.Equal("boundary_chainage", top.MappingBasis);
            Assert.Equal(-37.25, top.TargetPoint.X, 6);
            Assert.Equal(0, top.TargetPoint.Y, 6);
            Assert.Equal(-26, right.TargetPoint.X, 6);
            Assert.Equal(-7.2, right.TargetPoint.Y, 6);
            Assert.Equal(-35, bottom.TargetPoint.X, 6);
            Assert.Equal(-12, bottom.TargetPoint.Y, 6);
            Assert.Equal(33.6667, top.TargetPoint.Z, 4);
            Assert.Equal("north", top.BoundarySide);
            Assert.Equal(0.375, top.NormalizedBoundaryChainage!.Value, 6);
            Assert.Null(top.SourceAnchorScopedId);
            Assert.Null(top.TargetHostAnchorScopedId);
        }

        [Fact]
        public void AnalogPlannerPairsRepeatedIdenticalAnchorsByNormalizedSpatialOrderRegardlessOfInputOrder()
        {
            var first = AnalogFixture();
            var second = AnalogFixture();
            second.SourceAnchors.Reverse();
            second.TargetAnchors.Reverse();
            second.ReferenceDevices.Reverse();

            var firstPlan = DwellingReceptacleAnalogPlanner.Plan(first);
            var secondPlan = DwellingReceptacleAnalogPlanner.Plan(second);

            Assert.Equal("target-vanity-left", firstPlan.ProposedPlacements.Single(x => x.SourceElementId == "405-gfci-vanity-left").TargetHostAnchorScopedId);
            Assert.Equal(firstPlan.ProposedPlacements.Select(x => x.SourceElementId), secondPlan.ProposedPlacements.Select(x => x.SourceElementId));
            Assert.Equal(firstPlan.ProposedPlacements.Select(x => x.TargetHostAnchorScopedId), secondPlan.ProposedPlacements.Select(x => x.TargetHostAnchorScopedId));
            Assert.Equal(firstPlan.ProposedPlacements.Select(x => x.TargetPoint.X), secondPlan.ProposedPlacements.Select(x => x.TargetPoint.X));
        }

        [Fact]
        public void AnalogPlannerFailsClosedForSemanticAnchorCountMismatch()
        {
            var input = AnalogFixture();
            input.TargetAnchors.RemoveAll(x => x.ScopedId == "target-vanity-right");

            var plan = DwellingReceptacleAnalogPlanner.Plan(input);

            Assert.Equal("manual_review", plan.Status);
            Assert.Empty(plan.ProposedPlacements);
            Assert.Contains(plan.ManualReviews, x => x.Code == "anchor_signature_multiset_mismatch");
            Assert.Contains(plan.ManualReviews, x => x.Code == "anchor_signature_target_count_insufficient" && x.AnchorSignature == "plumbing_fixtures|vanity_sink|*");
        }

        [Fact]
        public void AnalogPlannerAllowsExtraTargetAnchorsAndSelectsOneInjectivelyByNormalizedPosition()
        {
            var input = RepeatedAssignmentFixture();
            input.SourceAnchors.RemoveAll(x => x.ScopedId == "source-high");
            input.TargetAnchors.Add(Anchor("target-extra", "Casework", "Cabinet", "A", 0.8, 0.8));

            var plan = DwellingReceptacleAnalogPlanner.Plan(input);

            Assert.Equal("ready", plan.Status);
            var placement = Assert.Single(plan.ProposedPlacements);
            Assert.Equal("target-low-y", placement.TargetHostAnchorScopedId);
        }

        [Fact]
        public void AnalogPlannerFallsBackToSameCategoryAndFamilyAcrossDifferentTargetTypeDimensions()
        {
            var input = AnalogFixture();
            input.TargetAnchors.Single(x => x.ScopedId == "target-counter-vanity").Type = "30 Inch Depth";

            var plan = DwellingReceptacleAnalogPlanner.Plan(input);

            Assert.Equal("ready", plan.Status);
            var placement = plan.ProposedPlacements.Single(x => x.SourceElementId == "405-standard-vanity");
            Assert.Equal("casework|counter|*", placement.SourceAnchorSignature);
            Assert.Equal(placement.SourceAnchorSignature, placement.TargetAnchorSignature);
            Assert.Contains("family_role", placement.MappingRuleTrace);
        }

        [Fact]
        public void AnalogPlannerStillFailsClosedWhenTargetSemanticFamilyIsDifferent()
        {
            var input = AnalogFixture();
            input.TargetAnchors.Single(x => x.ScopedId == "target-counter-vanity").Family = "Unrelated Shelf";

            var plan = DwellingReceptacleAnalogPlanner.Plan(input);

            Assert.Equal("manual_review", plan.Status);
            Assert.Empty(plan.ProposedPlacements);
            Assert.Contains(plan.ManualReviews, x => x.Code == "anchor_signature_target_count_insufficient");
        }

        [Theory]
        [InlineData("same-room")]
        [InlineData("no-devices")]
        [InlineData("nonfinite")]
        [InlineData("duplicate")]
        public void AnalogPlannerFailsClosedForInvalidInput(string caseName)
        {
            var input = AnalogFixture();
            if (caseName == "same-room") input.TargetRoom.RoomScopedId = input.SourceRoom.RoomScopedId;
            if (caseName == "no-devices") input.ReferenceDevices.Clear();
            if (caseName == "nonfinite") input.ReferenceDevices[0].Point.X = double.NaN;
            if (caseName == "duplicate") input.ReferenceDevices.Add(new DwellingReceptacleReferenceDevice
            {
                ElementId = "405-standard-top-copy",
                FamilyTypeKey = "Duplex Receptacle/Standard",
                Point = new Point3 { X = -10, Y = -2, Z = 33.6667 }
            });

            var plan = DwellingReceptacleAnalogPlanner.Plan(input);

            Assert.Equal("manual_review", plan.Status);
            Assert.Empty(plan.ProposedPlacements);
            Assert.NotEmpty(plan.ManualReviews);
        }

        [Fact]
        public void AnalogPlannerIsDeepDeterministicDoesNotAliasAndDoesNotInvokeTools()
        {
            var input = AnalogFixture();
            var first = DwellingReceptacleAnalogPlanner.Plan(input);
            var originalX = first.ProposedPlacements[0].TargetPoint.X;
            input.TargetRoom.MinX = -400;
            input.ReferenceDevices[0].Point.X = 400;
            var second = DwellingReceptacleAnalogPlanner.Plan(AnalogFixture());

            Assert.Equal(originalX, first.ProposedPlacements[0].TargetPoint.X);
            Assert.Equal(first.ProposedPlacements.Select(x => x.SourceElementId), second.ProposedPlacements.Select(x => x.SourceElementId));
            Assert.Equal(first.ProposedPlacements.Select(x => x.TargetPoint.X), second.ProposedPlacements.Select(x => x.TargetPoint.X));
            Assert.False(first.InvokedTools);
        }

        [Fact]
        public void AnalogPlannerFailsClosedWhenDeclaredSemanticHostIsTooFar()
        {
            var input = AnalogFixture();
            input.ReferenceDevices.Single(x => x.ElementId == "405-gfci-kitchen-sink").Point.X += 8;

            var plan = DwellingReceptacleAnalogPlanner.Plan(input);

            Assert.Equal("manual_review", plan.Status);
            Assert.Empty(plan.ProposedPlacements);
            Assert.Contains(plan.ManualReviews, x => x.Code == "semantic_host_distance_exceeded");
        }

        [Theory]
        [InlineData("category")]
        [InlineData("family")]
        [InlineData("type")]
        [InlineData("pipe")]
        public void AnalogPlannerRejectsMalformedAnchorSignatureComponents(string component)
        {
            var input = AnalogFixture();
            var anchor = input.SourceAnchors[0];
            if (component == "category") anchor.Category = "";
            if (component == "family") anchor.Family = " ";
            if (component == "type") anchor.Type = "";
            if (component == "pipe") anchor.Family = "Vanity|Sink";

            var plan = DwellingReceptacleAnalogPlanner.Plan(input);

            Assert.Equal("manual_review", plan.Status);
            Assert.Contains(plan.ManualReviews, x => x.Code == "malformed_source_anchor");
        }

        [Fact]
        public void AnalogPlannerFailsClosedForUnusedSignatureCountMismatch()
        {
            var input = AnalogFixture();
            input.TargetAnchors.RemoveAll(x => x.ScopedId == "target-panel");

            var plan = DwellingReceptacleAnalogPlanner.Plan(input);

            Assert.Equal("manual_review", plan.Status);
            Assert.Contains(plan.ManualReviews, x => x.Code == "anchor_signature_multiset_mismatch");
        }

        [Fact]
        public void AnalogPlannerUsesMinimumCostNormalizedXyAssignmentRatherThanIndependentOrdering()
        {
            var input = RepeatedAssignmentFixture();

            var plan = DwellingReceptacleAnalogPlanner.Plan(input);

            Assert.Equal("ready", plan.Status);
            var placement = Assert.Single(plan.ProposedPlacements);
            Assert.Equal("target-low-y", placement.TargetHostAnchorScopedId);
        }

        [Fact]
        public void AnalogPlannerFailsClosedForGenuinelyAmbiguousRepeatedAssignment()
        {
            var input = RepeatedAssignmentFixture();
            input.SourceAnchors[1].Point = new Point3 { X = 0.1, Y = 0.1, Z = 0 };
            input.TargetAnchors[0].Point = new Point3 { X = 0.5, Y = 0.5, Z = 0 };
            input.TargetAnchors[1].Point = new Point3 { X = 0.5, Y = 0.5, Z = 0 };

            var plan = DwellingReceptacleAnalogPlanner.Plan(input);

            Assert.Equal("manual_review", plan.Status);
            Assert.Contains(plan.ManualReviews, x => x.Code == "ambiguous_anchor_assignment");
        }

        [Theory]
        [InlineData("signature")]
        [InlineData("category")]
        public void AnalogPlannerValidatesDeclaredHostConsistency(string inconsistency)
        {
            var input = AnalogFixture();
            var device = input.ReferenceDevices.Single(x => x.ElementId == "405-gfci-kitchen-sink");
            if (inconsistency == "signature") device.SourceHostSignature = "casework|counter_top|standard";
            if (inconsistency == "category") device.SourceHostCategory = "Casework";

            var plan = DwellingReceptacleAnalogPlanner.Plan(input);

            Assert.Equal("manual_review", plan.Status);
            Assert.Contains(plan.ManualReviews, x => x.Code == (inconsistency == "signature" ? "source_host_signature_mismatch" : "source_host_category_mismatch"));
        }

        [Fact]
        public void AnalogPlannerFailsClosedForDerivedOverflowAndPhysicalNearCollision()
        {
            var overflow = AnalogFixture();
            overflow.TargetRoom.MinX = double.MaxValue;
            overflow.TargetRoom.WidthFt = double.MaxValue;
            var overflowPlan = DwellingReceptacleAnalogPlanner.Plan(overflow);
            Assert.Equal("manual_review", overflowPlan.Status);
            Assert.Contains(overflowPlan.ManualReviews, x => x.Code == "malformed_room_frame");

            var collision = AnalogFixture();
            collision.ReferenceDevices.Add(Device("405-standard-top-near", "Duplex Receptacle/Standard", -9.99, -2));
            var collisionPlan = DwellingReceptacleAnalogPlanner.Plan(collision);
            Assert.Equal("manual_review", collisionPlan.Status);
            Assert.Contains(collisionPlan.ManualReviews, x => x.Code == "physical_target_collision");
        }

        private static DwellingReceptacleAnalogPlanInput RepeatedAssignmentFixture()
        {
            var input = new DwellingReceptacleAnalogPlanInput
            {
                SourceRoom = new DwellingReceptacleAnalogRoomFrame { RoomScopedId = "source", MinX = 0, MinY = 0, WidthFt = 1, DepthFt = 1, FloorZ = 0 },
                TargetRoom = new DwellingReceptacleAnalogRoomFrame { RoomScopedId = "target", MinX = 0, MinY = 0, WidthFt = 1, DepthFt = 1, FloorZ = 0 }
            };
            input.SourceAnchors.Add(Anchor("source-low", "Casework", "Cabinet", "A", 0.1, 0.1));
            input.SourceAnchors.Add(Anchor("source-high", "Casework", "Cabinet", "A", 0.2, 0.9));
            input.TargetAnchors.Add(Anchor("target-high-y", "Casework", "Cabinet", "A", 0.1, 0.9));
            input.TargetAnchors.Add(Anchor("target-low-y", "Casework", "Cabinet", "A", 0.2, 0.1));
            input.ReferenceDevices.Add(Device("semantic", "Duplex Receptacle/Standard", 0.1, 0.1, "source-low", 1));
            return input;
        }

        private static DwellingReceptacleAnalogPlanInput AnalogFixture()
        {
            var input = new DwellingReceptacleAnalogPlanInput
            {
                SourceRoom = new DwellingReceptacleAnalogRoomFrame { RoomScopedId = "room:405", MinX = -16, MinY = -12, WidthFt = 16, DepthFt = 10, FloorZ = 32 },
                TargetRoom = new DwellingReceptacleAnalogRoomFrame { RoomScopedId = "room:403", MinX = -44, MinY = -12, WidthFt = 18, DepthFt = 12, FloorZ = 32 },
                SemanticAnchorMaxDistanceFt = 6,
                DuplicateTargetPointToleranceFt = 0.05
            };
            input.SourceAnchors.AddRange(new[]
            {
                Anchor("source-vanity-left", "Plumbing Fixtures", "Vanity Sink", "Standard", -6.9737, -10.6563),
                Anchor("source-vanity-right", "Plumbing Fixtures", "Vanity Sink", "Standard", -11.6741, -10.6563),
                Anchor("source-kitchen-sink", "Plumbing Fixtures", "Kitchen Sink", "Standard", -2.0729, -8.4792),
                Anchor("source-washer", "Plumbing Fixtures", "Washer", "Standard", -13.9063, -3.375),
                Anchor("source-shower", "Generic Models", "Shower", "Standard", -3.1667, -4.2135),
                Anchor("source-counter-vanity", "Casework", "Counter Top", "Standard", -14.5104, -10.7083),
                Anchor("source-cabinet-gfci", "Casework", "Base Cabinet", "Standard", -2.0729, -6.3958),
                Anchor("source-cabinet-counter", "Casework", "Wall Cabinet", "Standard", -2.0729, -4.3125),
                Anchor("source-casework-4", "Casework", "Base Cabinet", "Standard", -12, -5), Anchor("source-casework-5", "Casework", "Base Cabinet", "Standard", -9, -5),
                Anchor("source-casework-6", "Casework", "Base Cabinet", "Standard", -6, -5), Anchor("source-casework-7", "Casework", "Base Cabinet", "Standard", -4, -5),
                Anchor("source-plumbing-5", "Plumbing Fixtures", "Toilet", "Standard", -12, -9), Anchor("source-plumbing-6", "Plumbing Fixtures", "Toilet", "Standard", -10, -9),
                Anchor("source-plumbing-7", "Plumbing Fixtures", "Toilet", "Standard", -8, -9), Anchor("source-plumbing-8", "Plumbing Fixtures", "Toilet", "Standard", -6, -9),
                Anchor("source-plumbing-9", "Plumbing Fixtures", "Toilet", "Standard", -4, -9), Anchor("source-plumbing-10", "Plumbing Fixtures", "Toilet", "Standard", -2, -9),
                Anchor("source-door-1", "Doors", "Door", "Single", -16, -7), Anchor("source-door-2", "Doors", "Door", "Single", -16, -3),
                Anchor("source-panel", "Electrical Equipment", "Panel", "Standard", -15, -2)
            });
            input.TargetAnchors.AddRange(new[]
            {
                Anchor("target-vanity-left", "Plumbing Fixtures", "Vanity Sink", "Standard", -34.5567, -10.6563, "host:403:vanity-left"),
                Anchor("target-vanity-right", "Plumbing Fixtures", "Vanity Sink", "Standard", -39.2571, -10.6563),
                Anchor("target-kitchen-sink", "Plumbing Fixtures", "Kitchen Sink", "Standard", -28.4269, -8.3542, "host:403:kitchen-sink"),
                Anchor("target-washer", "Plumbing Fixtures", "Washer", "Standard", -41.4893, -3.375),
                Anchor("target-shower", "Generic Models", "Shower", "Standard", -30.7500, -4.2135),
                Anchor("target-counter-vanity", "Casework", "Counter Top", "Standard", -42.0934, -10.7083),
                Anchor("target-cabinet-gfci", "Casework", "Base Cabinet", "Standard", -28.4269, -6.2708),
                Anchor("target-cabinet-counter", "Casework", "Wall Cabinet", "Standard", -28.4269, -4.1875),
                Anchor("target-casework-4", "Casework", "Base Cabinet", "Standard", -39, -5), Anchor("target-casework-5", "Casework", "Base Cabinet", "Standard", -36, -5),
                Anchor("target-casework-6", "Casework", "Base Cabinet", "Standard", -33, -5), Anchor("target-casework-7", "Casework", "Base Cabinet", "Standard", -31, -5),
                Anchor("target-plumbing-5", "Plumbing Fixtures", "Toilet", "Standard", -40, -9), Anchor("target-plumbing-6", "Plumbing Fixtures", "Toilet", "Standard", -38, -9),
                Anchor("target-plumbing-7", "Plumbing Fixtures", "Toilet", "Standard", -36, -9), Anchor("target-plumbing-8", "Plumbing Fixtures", "Toilet", "Standard", -34, -9),
                Anchor("target-plumbing-9", "Plumbing Fixtures", "Toilet", "Standard", -32, -9), Anchor("target-plumbing-10", "Plumbing Fixtures", "Toilet", "Standard", -30, -9),
                Anchor("target-door-1", "Doors", "Door", "Single", -44, -7), Anchor("target-door-2", "Doors", "Door", "Single", -44, -3),
                Anchor("target-panel", "Electrical Equipment", "Panel", "Standard", -43, -2)
            });
            input.ReferenceDevices.AddRange(new[]
            {
                Device("405-standard-top", "Duplex Receptacle/Standard", -10, -2), Device("405-standard-right", "Duplex Receptacle/Standard", 0, -8),
                Device("405-standard-left", "Duplex Receptacle/Standard", -16, -8), Device("405-standard-lower-left", "Duplex Receptacle/Standard", -14, -12),
                Device("405-standard-lower-right", "Duplex Receptacle/Standard", -2, -12), Device("405-standard-bottom", "Duplex Receptacle/Standard", -8, -12),
                Device("405-standard-vanity", "Duplex Receptacle/Standard", -14.5104, -10.7083, "source-counter-vanity"),
                Device("405-gfci-vanity-left", "Duplex Receptacle/GFCI", -6.9737, -10.6563, "source-vanity-left"), Device("405-gfci-vanity-right", "Duplex Receptacle/GFCI", -11.6741, -10.6563, "source-vanity-right"),
                Device("405-gfci-kitchen-sink", "Duplex Receptacle/GFCI", -2.0729, -8.4792, "source-kitchen-sink"), Device("405-gfci-cabinet", "Duplex Receptacle/GFCI", -2.0729, -6.3958, "source-cabinet-gfci", 36.1667),
                Device("405-countertop", "Duplex Receptacle/Counter Top", -2.0729, -4.3125, "source-cabinet-counter"), Device("405-hv-washer", "High Voltage Receptacle/Standard", -13.9063, -3.375, "source-washer"),
                Device("405-hv-shower", "High Voltage Receptacle/Standard", -3.1667, -4.2135, "source-shower")
            });
            var kitchenGfci = input.ReferenceDevices.Single(x => x.ElementId == "405-gfci-kitchen-sink");
            kitchenGfci.SourceHostCategory = "Plumbing Fixtures";
            kitchenGfci.SourceHostSignature = "Plumbing Fixtures|Kitchen Sink|Standard";
            return input;
        }

        private static DwellingReceptacleAnalogAnchor Anchor(string id, string category, string family, string type, double x, double y, string? hostId = null)
            => new DwellingReceptacleAnalogAnchor { ScopedId = id, Category = category, Family = family, Type = type, Point = new Point3 { X = x, Y = y, Z = 32 }, HostScopedId = hostId };

        private static DwellingReceptacleReferenceDevice Device(string id, string familyType, double x, double y, string? hostId = null, double z = 33.6667)
            => new DwellingReceptacleReferenceDevice { ElementId = id, FamilyTypeKey = familyType, Point = new Point3 { X = x, Y = y, Z = z }, SourceHostScopedId = hostId };

        private static DwellingReceptaclePlanInput Input(params DwellingReceptacleWallSpace[] walls)
            => new DwellingReceptaclePlanInput
            {
                RoomId = 1390984,
                RoomNumber = "403",
                RoomName = "Live/Work Unit 403",
                RoomClassifications = new List<string> { "live_work_unit" },
                WallSpaces = walls.ToList()
            };

        private static DwellingReceptacleWallSpace Wall(string id, double startX, double endX)
            => new DwellingReceptacleWallSpace
            {
                WallSpaceId = id,
                HostScopedId = "link:1362762:wall-" + id,
                Start = new Point3 { X = startX, Y = 0, Z = 32 },
                End = new Point3 { X = endX, Y = 0, Z = 32 }
            };
    }
}
