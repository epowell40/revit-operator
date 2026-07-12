using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Security.Cryptography;
using System.Text;

namespace RevitBridge.Common.LowVoltage.Skills.DwellingReceptacles
{
    public sealed class DwellingReceptacleAnalogCandidate
    {
        public string RoomScopedId { get; set; } = string.Empty;
        public string RoomNumber { get; set; } = string.Empty;
        public string RoomName { get; set; } = string.Empty;
        public string LevelScopedId { get; set; } = string.Empty;
        public double AreaFt2 { get; set; }
        public double BoundaryLengthFt { get; set; }
        public double CentroidDistanceFt { get; set; }
        public int ReceptacleCount { get; set; }
        public double AnchorLayoutSimilarity { get; set; }
        public List<string> CuratedAnchorSignatures { get; set; } = new List<string>();
    }

    public sealed class DwellingReceptacleAnalogCandidateScore
    {
        public string RoomScopedId { get; set; } = string.Empty;
        public string RoomNumber { get; set; } = string.Empty;
        public double Score { get; set; }
        public bool CuratedSignatureParity { get; set; }
        public double NameCompatibility { get; set; }
        public double AreaSimilarity { get; set; }
        public double BoundarySimilarity { get; set; }
        public double AdjacencySimilarity { get; set; }
        public double AnchorLayoutSimilarity { get; set; }
        public int ReceptacleCount { get; set; }
    }

    public sealed class DwellingReceptacleAnalogCandidateSelection
    {
        public string Status { get; set; } = "ambiguous";
        public string? SelectedRoomScopedId { get; set; }
        public List<DwellingReceptacleAnalogCandidateScore> CandidateScores { get; set; } = new List<DwellingReceptacleAnalogCandidateScore>();
        public string? Blocker { get; set; }
    }

    public sealed class OptionalPostCommitArtifactResult<T>
    {
        public bool CaptureSucceeded { get; set; }
        public T Value { get; set; } = default!;
        public string? CaptureFailureKind { get; set; }
        public bool CleanupSucceeded { get; set; }
        public string? CleanupFailureKind { get; set; }
    }

    /// <summary>Pure runtime rules shared by native plan/apply handlers.</summary>
    public static class DwellingReceptacleAnalogRuntime
    {
        public const string PlanSchema = "revit-operator.room-receptacle-analog-native-plan.v1";
        public const double MinimumUniqueScoreMargin = 0.005;

        private static readonly HashSet<string> CuratedCategories = new HashSet<string>(StringComparer.OrdinalIgnoreCase)
        {
            "Casework", "Plumbing Fixtures", "Doors", "Generic Models", "Electrical Equipment", "Wall Sweeps", "WallSweep"
        };

        public static bool IsCuratedAnchorCategory(string? category, bool exactReferencedWallSweep = false)
        {
            if (exactReferencedWallSweep) return true;
            return !string.IsNullOrWhiteSpace(category) && CuratedCategories.Contains(category.Trim());
        }

        public static OptionalPostCommitArtifactResult<T> CaptureOptionalPostCommitArtifact<T>(Func<T> capture, Func<bool> cleanup)
        {
            if (capture == null) throw new ArgumentNullException(nameof(capture));
            if (cleanup == null) throw new ArgumentNullException(nameof(cleanup));
            var result = new OptionalPostCommitArtifactResult<T>();
            try
            {
                result.Value = capture();
                result.CaptureSucceeded = true;
            }
            catch (Exception ex)
            {
                result.CaptureFailureKind = ex.GetType().Name;
            }
            finally
            {
                try
                {
                    result.CleanupSucceeded = cleanup();
                    if (!result.CleanupSucceeded) result.CleanupFailureKind = "cleanup_not_proven";
                }
                catch (Exception ex)
                {
                    result.CleanupFailureKind = ex.GetType().Name;
                }
            }
            return result;
        }

        public static DwellingReceptacleAnalogCandidateSelection SelectUniqueCandidate(
            DwellingReceptacleAnalogCandidate target,
            IEnumerable<DwellingReceptacleAnalogCandidate> candidates,
            double minimumMargin = MinimumUniqueScoreMargin)
        {
            if (target == null) throw new ArgumentNullException(nameof(target));
            if (candidates == null) throw new ArgumentNullException(nameof(candidates));
            if (!Finite(minimumMargin) || minimumMargin <= 0) throw new ArgumentOutOfRangeException(nameof(minimumMargin));

            var targetSignatures = SortedMultiset(target.CuratedAnchorSignatures);
            var scores = candidates
                .Where(x => x != null && x.ReceptacleCount > 0)
                .Where(x => !string.Equals(x.RoomScopedId, target.RoomScopedId, StringComparison.Ordinal))
                .Where(x => string.Equals(x.LevelScopedId, target.LevelScopedId, StringComparison.Ordinal))
                .Select(candidate =>
                {
                    var candidateSignatures = SortedMultiset(candidate.CuratedAnchorSignatures);
                    // An empty evidence set is mathematically a subset, but it is not
                    // a proven professional analog. Require at least one used semantic
                    // host signature before awarding curated-parity eligibility.
                    // Candidate signatures are emitted per device while target
                    // signatures are emitted per available anchor. Several source
                    // devices may intentionally reference the same casework or
                    // fixture, so multiplicity is not a compatibility requirement.
                    var parity = candidateSignatures.Count > 0 && IsSetSubset(candidateSignatures, targetSignatures);
                    var name = UnitNameCompatibility(target.RoomName, candidate.RoomName);
                    var area = RatioSimilarity(target.AreaFt2, candidate.AreaFt2);
                    var boundary = RatioSimilarity(target.BoundaryLengthFt, candidate.BoundaryLengthFt);
                    var adjacency = Finite(candidate.CentroidDistanceFt) && candidate.CentroidDistanceFt >= 0
                        ? 1.0 / (1.0 + (candidate.CentroidDistanceFt / 50.0))
                        : 0.0;
                    var anchorLayout = Finite(candidate.AnchorLayoutSimilarity)
                        ? Math.Max(0.0, Math.Min(1.0, candidate.AnchorLayoutSimilarity))
                        : 0.0;
                    var score = (parity ? 0.42 : 0.0) + (anchorLayout * 0.18) + (name * 0.12) + (area * 0.10) + (boundary * 0.08) + (adjacency * 0.10);
                    return new DwellingReceptacleAnalogCandidateScore
                    {
                        RoomScopedId = candidate.RoomScopedId,
                        RoomNumber = candidate.RoomNumber,
                        Score = Round(score),
                        CuratedSignatureParity = parity,
                        NameCompatibility = Round(name),
                        AreaSimilarity = Round(area),
                        BoundarySimilarity = Round(boundary),
                        AdjacencySimilarity = Round(adjacency),
                        AnchorLayoutSimilarity = Round(anchorLayout),
                        ReceptacleCount = candidate.ReceptacleCount
                    };
                })
                .OrderByDescending(x => x.Score)
                .ThenBy(x => x.RoomNumber, StringComparer.Ordinal)
                .ThenBy(x => x.RoomScopedId, StringComparer.Ordinal)
                .ToList();

            var selection = new DwellingReceptacleAnalogCandidateSelection { CandidateScores = scores.Take(12).ToList() };
            if (scores.Count == 0)
            {
                selection.Blocker = "no_same_level_nonempty_candidate";
                return selection;
            }
            if (!scores[0].CuratedSignatureParity)
            {
                selection.Blocker = "best_candidate_curated_signature_mismatch";
                return selection;
            }
            var parityEligible = scores.Where(score => score.CuratedSignatureParity).ToList();
            if (parityEligible.Count > 1 && (parityEligible[0].Score - parityEligible[1].Score) < minimumMargin)
            {
                selection.Blocker = "candidate_score_margin_ambiguous";
                return selection;
            }
            selection.Status = "selected";
            selection.SelectedRoomScopedId = scores[0].RoomScopedId;
            return selection;
        }

        public static string ComputePlanHash(IEnumerable<KeyValuePair<string, string>> canonicalFields)
        {
            if (canonicalFields == null) throw new ArgumentNullException(nameof(canonicalFields));
            var rows = canonicalFields.Select(field =>
            {
                var key = (field.Key ?? string.Empty).Trim();
                if (key.Length == 0 || key.IndexOf('\n') >= 0 || key.IndexOf('\r') >= 0)
                    throw new ArgumentException("Canonical field keys must be nonblank single-line strings.", nameof(canonicalFields));
                var value = field.Value ?? string.Empty;
                if (value.IndexOf('\n') >= 0 || value.IndexOf('\r') >= 0)
                    throw new ArgumentException("Canonical field values must be single-line strings.", nameof(canonicalFields));
                return key + "=" + value;
            }).OrderBy(x => x, StringComparer.Ordinal).ToList();
            if (rows.Count == 0) throw new ArgumentException("At least one canonical field is required.", nameof(canonicalFields));
            var canonical = PlanSchema + "\n" + string.Join("\n", rows);
            using (var sha = SHA256.Create())
            {
                var bytes = sha.ComputeHash(Encoding.UTF8.GetBytes(canonical));
                return string.Concat(bytes.Select(x => x.ToString("x2", CultureInfo.InvariantCulture)));
            }
        }

        public static string CanonicalNumber(double value)
        {
            if (!Finite(value)) throw new ArgumentOutOfRangeException(nameof(value));
            return Math.Round(value, 6, MidpointRounding.AwayFromZero).ToString("0.######", CultureInfo.InvariantCulture);
        }

        private static List<string> SortedMultiset(IEnumerable<string>? values) =>
            (values ?? Enumerable.Empty<string>()).Select(x => (x ?? string.Empty).Trim().ToLowerInvariant()).OrderBy(x => x, StringComparer.Ordinal).ToList();

        private static bool IsSetSubset(IReadOnlyCollection<string> required, IReadOnlyCollection<string> available)
        {
            var availableSet = new HashSet<string>(available, StringComparer.Ordinal);
            return required.All(availableSet.Contains);
        }

        private static double UnitNameCompatibility(string? a, string? b)
        {
            var left = NormalizeName(a);
            var right = NormalizeName(b);
            if (left.Length == 0 || right.Length == 0) return 0;
            if (string.Equals(left, right, StringComparison.Ordinal)) return 1;
            var leftTokens = new HashSet<string>(left.Split(new[] { ' ' }, StringSplitOptions.RemoveEmptyEntries), StringComparer.Ordinal);
            var rightTokens = new HashSet<string>(right.Split(new[] { ' ' }, StringSplitOptions.RemoveEmptyEntries), StringComparer.Ordinal);
            var union = new HashSet<string>(leftTokens, StringComparer.Ordinal);
            union.UnionWith(rightTokens);
            leftTokens.IntersectWith(rightTokens);
            return union.Count == 0 ? 0 : (double)leftTokens.Count / union.Count;
        }

        private static string NormalizeName(string? text)
        {
            var chars = (text ?? string.Empty).ToLowerInvariant().Select(ch => char.IsLetter(ch) ? ch : ' ').ToArray();
            return string.Join(" ", new string(chars).Split(new[] { ' ' }, StringSplitOptions.RemoveEmptyEntries));
        }

        private static double RatioSimilarity(double a, double b)
        {
            if (!Finite(a) || !Finite(b) || a <= 0 || b <= 0) return 0;
            return Math.Min(a, b) / Math.Max(a, b);
        }

        private static bool Finite(double value) => !double.IsNaN(value) && !double.IsInfinity(value);
        private static double Round(double value) => Math.Round(value, 6, MidpointRounding.AwayFromZero);
    }
}
