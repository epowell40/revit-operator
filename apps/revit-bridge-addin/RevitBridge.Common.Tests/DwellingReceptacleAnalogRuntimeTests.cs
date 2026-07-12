using System;
using System.Collections.Generic;
using RevitBridge.Common.LowVoltage.Skills.DwellingReceptacles;
using Xunit;

namespace RevitBridge.Common.Tests
{
    public sealed class DwellingReceptacleAnalogRuntimeTests
    {
        [Fact]
        public void SelectUniqueCandidate_UsesCuratedParityAndUniqueMargin()
        {
            var target = Candidate("target", "403", "Live Work Unit", 0, 840, 130, "casework|a|b", "plumbing fixtures|c|d");
            var selected = Candidate("source-405", "405", "Live Work Loft Unit", 14, 830, 128, "casework|a|b", "plumbing fixtures|c|d");
            selected.CentroidDistanceFt = 28;
            var poor = Candidate("source-499", "499", "Storage", 3, 300, 75, "casework|wrong|wrong");
            poor.CentroidDistanceFt = 4;

            var result = DwellingReceptacleAnalogRuntime.SelectUniqueCandidate(target, new[] { poor, selected });

            Assert.Equal("selected", result.Status);
            Assert.Equal("source-405", result.SelectedRoomScopedId);
            Assert.True(result.CandidateScores[0].CuratedSignatureParity);
        }

        [Fact]
        public void SelectUniqueCandidate_FailsClosedOnTie()
        {
            var target = Candidate("target", "403", "Live Work Unit", 0, 840, 130, "casework|a|b");
            var a = Candidate("a", "405", "Live Work Unit", 14, 840, 130, "casework|a|b");
            var b = Candidate("b", "407", "Live Work Unit", 14, 840, 130, "casework|a|b");
            a.CentroidDistanceFt = b.CentroidDistanceFt = 25;

            var result = DwellingReceptacleAnalogRuntime.SelectUniqueCandidate(target, new[] { a, b });

            Assert.Equal("ambiguous", result.Status);
            Assert.Equal("candidate_score_margin_ambiguous", result.Blocker);
        }

        [Fact]
        public void SelectUniqueCandidate_DoesNotLetIneligibleSignatureMismatchCreateFalseAmbiguity()
        {
            var target = Candidate("target", "403", "Live Work Unit", 0, 840, 130, "casework|a|b");
            var eligible = Candidate("source-405", "405", "Live Work Unit", 14, 800, 125, "casework|a|b");
            eligible.CentroidDistanceFt = 30;
            var ineligible = Candidate("source-404", "404", "Live Work Unit", 14, 840, 130, "casework|different|different");
            ineligible.CentroidDistanceFt = 1;

            var result = DwellingReceptacleAnalogRuntime.SelectUniqueCandidate(target, new[] { ineligible, eligible });

            Assert.Equal("selected", result.Status);
            Assert.Equal("source-405", result.SelectedRoomScopedId);
        }

        [Fact]
        public void SelectUniqueCandidate_AllowsUnrelatedTargetAnchorsBeyondUsedSourceSignatures()
        {
            var target = Candidate("target", "403", "Live Work Unit", 0, 840, 130, "casework|used|type", "doors|unrelated|type");
            var source = Candidate("source-405", "405", "Live Work Unit", 14, 830, 128, "casework|used|type");
            source.CentroidDistanceFt = 20;

            var result = DwellingReceptacleAnalogRuntime.SelectUniqueCandidate(target, new[] { source });

            Assert.Equal("selected", result.Status);
            Assert.True(result.CandidateScores[0].CuratedSignatureParity);
        }

        [Fact]
        public void SelectUniqueCandidate_DoesNotRequireDuplicateTargetAnchorsForRepeatedDeviceSignature()
        {
            var target = Candidate("target", "403", "Live Work Unit", 0, 840, 130, "casework|shared|type");
            var source = Candidate("source-405", "405", "Live Work Unit", 14, 830, 128,
                "casework|shared|type", "casework|shared|type", "casework|shared|type");
            source.CentroidDistanceFt = 20;

            var result = DwellingReceptacleAnalogRuntime.SelectUniqueCandidate(target, new[] { source });

            Assert.Equal("selected", result.Status);
            Assert.Equal("source-405", result.SelectedRoomScopedId);
            Assert.True(result.CandidateScores[0].CuratedSignatureParity);
        }

        [Fact]
        public void SelectUniqueCandidate_DoesNotTreatEmptySemanticEvidenceAsParity()
        {
            var target = Candidate("target", "403", "Live Work Unit", 0, 840, 130, "casework|used|type");
            var corridor = Candidate("corridor-402", "402", "Corridor", 2, 840, 130);
            corridor.CentroidDistanceFt = 1;
            var unit = Candidate("source-405", "405", "Live Work Unit", 14, 800, 125, "casework|used|type");
            unit.CentroidDistanceFt = 30;

            var result = DwellingReceptacleAnalogRuntime.SelectUniqueCandidate(target, new[] { corridor, unit });

            Assert.Equal("selected", result.Status);
            Assert.Equal("source-405", result.SelectedRoomScopedId);
            Assert.False(result.CandidateScores.Find(score => score.RoomNumber == "402")!.CuratedSignatureParity);
        }

        [Fact]
        public void SelectUniqueCandidate_UsesSemanticAnchorLayoutToResolveOtherwiseSimilarUnits()
        {
            var target = Candidate("target", "403", "Live Work Unit", 0, 840, 130, "casework|used|type");
            var corresponding = Candidate("source-405", "405", "Live Work Loft Unit", 14, 723, 125, "casework|used|type");
            corresponding.CentroidDistanceFt = 28;
            corresponding.AnchorLayoutSimilarity = 0.96;
            var merelySimilar = Candidate("source-410", "410", "Live Work Unit", 14, 768, 127, "casework|used|type");
            merelySimilar.CentroidDistanceFt = 30;
            merelySimilar.AnchorLayoutSimilarity = 0.30;

            var result = DwellingReceptacleAnalogRuntime.SelectUniqueCandidate(target, new[] { merelySimilar, corresponding });

            Assert.Equal("selected", result.Status);
            Assert.Equal("source-405", result.SelectedRoomScopedId);
            Assert.True(result.CandidateScores[0].AnchorLayoutSimilarity > result.CandidateScores[1].AnchorLayoutSimilarity);
        }

        [Fact]
        public void CuratedAnchorFilter_IncludesExactWallSweepButNotIncidentalFurniture()
        {
            Assert.True(DwellingReceptacleAnalogRuntime.IsCuratedAnchorCategory("Casework"));
            Assert.True(DwellingReceptacleAnalogRuntime.IsCuratedAnchorCategory("Wall Sweeps"));
            Assert.True(DwellingReceptacleAnalogRuntime.IsCuratedAnchorCategory("Anything", exactReferencedWallSweep: true));
            Assert.False(DwellingReceptacleAnalogRuntime.IsCuratedAnchorCategory("Furniture"));
            Assert.False(DwellingReceptacleAnalogRuntime.IsCuratedAnchorCategory("Walls"));
        }

        [Fact]
        public void PlanHash_IsOrderIndependentButDetectsGeometryDrift()
        {
            var a = DwellingReceptacleAnalogRuntime.ComputePlanHash(new[]
            {
                Pair("target.point.1", "1.25,2,3"), Pair("schema", "v1"), Pair("source.symbol.1", "uid-a")
            });
            var b = DwellingReceptacleAnalogRuntime.ComputePlanHash(new[]
            {
                Pair("source.symbol.1", "uid-a"), Pair("schema", "v1"), Pair("target.point.1", "1.25,2,3")
            });
            var drift = DwellingReceptacleAnalogRuntime.ComputePlanHash(new[]
            {
                Pair("source.symbol.1", "uid-a"), Pair("schema", "v1"), Pair("target.point.1", "1.251,2,3")
            });

            Assert.Equal(a, b);
            Assert.NotEqual(a, drift);
            Assert.Equal(64, a.Length);
        }

        [Fact]
        public void OptionalPostCommitArtifact_FailsCaptureClosedButAlwaysRunsCleanup()
        {
            var cleanupCalls = 0;
            var startFailure = DwellingReceptacleAnalogRuntime.CaptureOptionalPostCommitArtifact<string>(
                () => throw new InvalidOperationException("group start"),
                () => { cleanupCalls++; return true; });
            Assert.False(startFailure.CaptureSucceeded);
            Assert.Equal("InvalidOperationException", startFailure.CaptureFailureKind);
            Assert.True(startFailure.CleanupSucceeded);
            Assert.Equal(1, cleanupCalls);

            var exportFailure = DwellingReceptacleAnalogRuntime.CaptureOptionalPostCommitArtifact<string>(
                () => throw new ApplicationException("export"),
                () => { cleanupCalls++; return true; });
            Assert.False(exportFailure.CaptureSucceeded);
            Assert.Equal("ApplicationException", exportFailure.CaptureFailureKind);
            Assert.True(exportFailure.CleanupSucceeded);
            Assert.Equal(2, cleanupCalls);
        }

        [Fact]
        public void OptionalPostCommitArtifact_ReportsUnprovenOrThrowingCleanupWithoutLosingCaptureState()
        {
            var unproven = DwellingReceptacleAnalogRuntime.CaptureOptionalPostCommitArtifact(() => "preview.png", () => false);
            Assert.True(unproven.CaptureSucceeded);
            Assert.Equal("preview.png", unproven.Value);
            Assert.False(unproven.CleanupSucceeded);
            Assert.Equal("cleanup_not_proven", unproven.CleanupFailureKind);

            var throwing = DwellingReceptacleAnalogRuntime.CaptureOptionalPostCommitArtifact(
                () => "preview.png",
                () => throw new InvalidOperationException("rollback"));
            Assert.True(throwing.CaptureSucceeded);
            Assert.False(throwing.CleanupSucceeded);
            Assert.Equal("InvalidOperationException", throwing.CleanupFailureKind);
        }

        private static KeyValuePair<string, string> Pair(string key, string value) => new KeyValuePair<string, string>(key, value);

        private static DwellingReceptacleAnalogCandidate Candidate(string id, string number, string name, int devices, double area, double boundary, params string[] anchors) =>
            new DwellingReceptacleAnalogCandidate
            {
                RoomScopedId = id,
                RoomNumber = number,
                RoomName = name,
                LevelScopedId = "level-4",
                ReceptacleCount = devices,
                AreaFt2 = area,
                BoundaryLengthFt = boundary,
                CuratedAnchorSignatures = new List<string>(anchors)
            };
    }
}
