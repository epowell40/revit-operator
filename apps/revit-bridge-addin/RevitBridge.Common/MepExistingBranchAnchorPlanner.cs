using System;
using System.Collections.Generic;
using System.Linq;

namespace RevitBridge.Common
{
    public sealed class MepBranchAnchorPoint
    {
        public double X { get; set; }
        public double Y { get; set; }
        public double Z { get; set; }

        public double DistanceTo(MepBranchAnchorPoint other)
        {
            var dx = X - other.X;
            var dy = Y - other.Y;
            var dz = Z - other.Z;
            return Math.Sqrt(dx * dx + dy * dy + dz * dz);
        }
    }

    public sealed class MepBranchAnchorSize
    {
        public string Domain { get; set; } = "";
        public string Shape { get; set; } = "";
        public double? DiameterFt { get; set; }
        public double? WidthFt { get; set; }
        public double? HeightFt { get; set; }
    }

    public sealed class MepBranchAnchorConnector
    {
        public int Index { get; set; }
        public MepBranchAnchorPoint Origin { get; set; } = new MepBranchAnchorPoint();
        public MepBranchAnchorSize Size { get; set; } = new MepBranchAnchorSize();
        public bool PhysicallyConnected { get; set; }
    }

    public sealed class MepExistingBranchAnchorPlan
    {
        public bool ApplySupported { get; set; }
        public int? MainConnectorIndex { get; set; }
        public int? BranchConnectorIndex { get; set; }
        public double? MainConnectorDistanceToSplitFt { get; set; }
        public string BlockCode { get; set; } = "";
        public string BlockReason { get; set; } = "";
    }

    public static class MepExistingBranchAnchorPlanner
    {
        public static bool SupportsConnectionMode(string normalizedConnectionMode) =>
            string.Equals((normalizedConnectionMode ?? "").Trim(), "tee", StringComparison.OrdinalIgnoreCase);

        public static MepExistingBranchAnchorPlan Plan(
            IReadOnlyCollection<MepBranchAnchorConnector> connectors,
            MepBranchAnchorPoint splitPoint,
            MepBranchAnchorPoint downstreamPoint,
            MepBranchAnchorSize mainSize,
            MepBranchAnchorSize branchSize,
            double maximumSplitDistanceFt = 0.25,
            double sizeToleranceFt = 1.0 / 192.0)
        {
            if (connectors == null || splitPoint == null || downstreamPoint == null || mainSize == null || branchSize == null)
                return Blocked("anchor_input_missing", "Connector, geometry, and size inputs are required.");
            if (!FinitePoint(splitPoint) || !FinitePoint(downstreamPoint) || !FinitePositive(maximumSplitDistanceFt) || !FinitePositive(sizeToleranceFt))
                return Blocked("anchor_input_invalid", "Anchor geometry and tolerances must be finite and positive.");

            var open = connectors.Where(connector => connector != null && !connector.PhysicallyConnected).ToList();
            if (open.Count != 2)
                return Blocked("anchor_connector_count", $"Retained branch anchor must expose exactly two open physical connectors; found {open.Count}.");
            if (open.Select(connector => connector.Index).Distinct().Count() != 2 || open.Any(connector => !FinitePoint(connector.Origin)))
                return Blocked("anchor_connector_invalid", "Anchor connectors must have distinct indices and finite origins.");

            var mainCandidates = open
                .Where(connector => Compatible(connector.Size, mainSize, sizeToleranceFt))
                .Select(connector => new { Connector = connector, Distance = connector.Origin.DistanceTo(splitPoint) })
                .Where(candidate => candidate.Distance <= maximumSplitDistanceFt)
                .OrderBy(candidate => candidate.Distance)
                .ToList();
            if (mainCandidates.Count != 1)
                return Blocked(
                    mainCandidates.Count == 0 ? "anchor_main_connector_incompatible" : "anchor_main_connector_ambiguous",
                    mainCandidates.Count == 0
                        ? "No open retained-anchor connector matches the main domain, shape, size, and split-point tolerance."
                        : "More than one open retained-anchor connector could serve as the main-side connector.");

            var main = mainCandidates[0];
            var branch = open.Single(connector => connector.Index != main.Connector.Index);
            if (!Compatible(branch.Size, branchSize, sizeToleranceFt))
                return Blocked("anchor_branch_size_mismatch", "The retained anchor's opposite connector does not match the requested branch domain, shape, and size.");
            if (branch.Origin.DistanceTo(downstreamPoint) >= main.Connector.Origin.DistanceTo(downstreamPoint) - 1e-9)
                return Blocked("anchor_orientation_ambiguous", "The opposite retained-anchor connector does not point more directly toward the downstream branch point.");

            return new MepExistingBranchAnchorPlan
            {
                ApplySupported = true,
                MainConnectorIndex = main.Connector.Index,
                BranchConnectorIndex = branch.Index,
                MainConnectorDistanceToSplitFt = main.Distance
            };
        }

        private static bool Compatible(MepBranchAnchorSize actual, MepBranchAnchorSize requested, double toleranceFt)
        {
            if (actual == null || requested == null) return false;
            if (!EqualsNormalized(actual.Domain, requested.Domain) || !EqualsNormalized(actual.Shape, requested.Shape)) return false;
            if (EqualsNormalized(actual.Shape, "round"))
                return actual.DiameterFt.HasValue && requested.DiameterFt.HasValue && Math.Abs(actual.DiameterFt.Value - requested.DiameterFt.Value) <= toleranceFt;
            if (!actual.WidthFt.HasValue || !actual.HeightFt.HasValue || !requested.WidthFt.HasValue || !requested.HeightFt.HasValue) return false;
            var direct = Math.Abs(actual.WidthFt.Value - requested.WidthFt.Value) <= toleranceFt
                && Math.Abs(actual.HeightFt.Value - requested.HeightFt.Value) <= toleranceFt;
            var rotated = Math.Abs(actual.WidthFt.Value - requested.HeightFt.Value) <= toleranceFt
                && Math.Abs(actual.HeightFt.Value - requested.WidthFt.Value) <= toleranceFt;
            return direct || rotated;
        }

        private static bool EqualsNormalized(string a, string b) => string.Equals((a ?? "").Trim(), (b ?? "").Trim(), StringComparison.OrdinalIgnoreCase);
        private static bool FinitePositive(double value) => !double.IsNaN(value) && !double.IsInfinity(value) && value > 0;
        private static bool FinitePoint(MepBranchAnchorPoint point) => point != null && Finite(point.X) && Finite(point.Y) && Finite(point.Z);
        private static bool Finite(double value) => !double.IsNaN(value) && !double.IsInfinity(value);

        private static MepExistingBranchAnchorPlan Blocked(string code, string reason) => new MepExistingBranchAnchorPlan
        {
            ApplySupported = false,
            BlockCode = code,
            BlockReason = reason
        };
    }
}
