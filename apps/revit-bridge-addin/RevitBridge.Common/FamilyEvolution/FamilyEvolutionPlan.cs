using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Security.Cryptography;
using System.Text;

namespace RevitBridge.Common.FamilyEvolution
{
    public sealed class ClearanceSegment
    {
        public ClearanceSegment(double x1, double y1, double x2, double y2)
        {
            X1 = x1;
            Y1 = y1;
            X2 = x2;
            Y2 = y2;
        }

        public double X1 { get; }
        public double Y1 { get; }
        public double X2 { get; }
        public double Y2 { get; }
    }

    public static class FamilyEvolutionPlan
    {
        private const string Schema = "revit-operator-family-evolution-v2";

        public static string ResolveConnectorSide(
            double connectorX,
            double connectorY,
            double widthFt,
            double depthFt,
            double ambiguityToleranceFt = 1.0 / 96.0,
            double maximumEdgeDistanceFt = 0.25)
        {
            RequirePositiveFinite(widthFt, nameof(widthFt));
            RequirePositiveFinite(depthFt, nameof(depthFt));
            if (!Finite(connectorX) || !Finite(connectorY))
                throw new ArgumentOutOfRangeException("Connector coordinates must be finite.");
            if (!Finite(ambiguityToleranceFt) || ambiguityToleranceFt < 0)
                throw new ArgumentOutOfRangeException(nameof(ambiguityToleranceFt));
            if (!Finite(maximumEdgeDistanceFt) || maximumEdgeDistanceFt <= 0)
                throw new ArgumentOutOfRangeException(nameof(maximumEdgeDistanceFt));

            var halfWidth = widthFt / 2.0;
            var halfDepth = depthFt / 2.0;
            var distances = new[]
            {
                new KeyValuePair<string, double>("right", Math.Abs(connectorX - halfWidth)),
                new KeyValuePair<string, double>("left", Math.Abs(connectorX + halfWidth)),
                new KeyValuePair<string, double>("front", Math.Abs(connectorY - halfDepth)),
                new KeyValuePair<string, double>("back", Math.Abs(connectorY + halfDepth))
            }.OrderBy(x => x.Value).ThenBy(x => x.Key, StringComparer.Ordinal).ToList();

            if (distances.Count > 1 && Math.Abs(distances[1].Value - distances[0].Value) <= ambiguityToleranceFt)
                throw new InvalidOperationException("Electrical connector is ambiguous between two family sides.");
            if (distances[0].Value > maximumEdgeDistanceFt)
                throw new InvalidOperationException("Electrical connector is not close enough to a family side to infer a clearance side safely.");
            return distances[0].Key;
        }

        public static IReadOnlyList<ClearanceSegment> BuildClearanceRectangle(
            double widthFt,
            double depthFt,
            double offsetFt,
            string side)
        {
            RequirePositiveFinite(widthFt, nameof(widthFt));
            RequirePositiveFinite(depthFt, nameof(depthFt));
            RequirePositiveFinite(offsetFt, nameof(offsetFt));
            side = NormalizeSide(side);

            var halfWidth = widthFt / 2.0;
            var halfDepth = depthFt / 2.0;
            double minX;
            double maxX;
            double minY;
            double maxY;
            switch (side)
            {
                case "right":
                    minX = halfWidth;
                    maxX = halfWidth + offsetFt;
                    minY = -halfDepth;
                    maxY = halfDepth;
                    break;
                case "left":
                    minX = -halfWidth - offsetFt;
                    maxX = -halfWidth;
                    minY = -halfDepth;
                    maxY = halfDepth;
                    break;
                case "front":
                    minX = -halfWidth;
                    maxX = halfWidth;
                    minY = halfDepth;
                    maxY = halfDepth + offsetFt;
                    break;
                case "back":
                    minX = -halfWidth;
                    maxX = halfWidth;
                    minY = -halfDepth - offsetFt;
                    maxY = -halfDepth;
                    break;
                default:
                    throw new InvalidOperationException("Unsupported clearance side.");
            }

            return new[]
            {
                new ClearanceSegment(minX, minY, maxX, minY),
                new ClearanceSegment(maxX, minY, maxX, maxY),
                new ClearanceSegment(maxX, maxY, minX, maxY),
                new ClearanceSegment(minX, maxY, minX, minY)
            };
        }

        public static string ComputePlanHash(IEnumerable<KeyValuePair<string, string>> fields)
        {
            if (fields == null) throw new ArgumentNullException(nameof(fields));
            var rows = fields.Select(field =>
            {
                var key = (field.Key ?? string.Empty).Trim();
                var value = field.Value ?? string.Empty;
                if (key.Length == 0)
                    throw new ArgumentException("Plan hash keys must be nonblank strings.", nameof(fields));
                // Family names, formulas, descriptions, and arbitrary string
                // parameters can legitimately contain CR/LF. Length-prefix
                // both sides so multiline values remain collision-safe instead
                // of rejecting an otherwise valid family inspection plan.
                return key.Length.ToString(CultureInfo.InvariantCulture) + ":" + key
                    + "=" + value.Length.ToString(CultureInfo.InvariantCulture) + ":" + value;
            }).OrderBy(x => x, StringComparer.Ordinal).ToList();
            if (rows.Count == 0) throw new ArgumentException("At least one plan field is required.", nameof(fields));

            using (var sha = SHA256.Create())
            {
                var bytes = sha.ComputeHash(Encoding.UTF8.GetBytes(Schema + "\n" + string.Join("\n", rows)));
                return string.Concat(bytes.Select(x => x.ToString("x2", CultureInfo.InvariantCulture)));
            }
        }

        public static string CanonicalNumber(double value)
        {
            if (!Finite(value)) throw new ArgumentOutOfRangeException(nameof(value));
            return Math.Round(value, 8, MidpointRounding.AwayFromZero).ToString("0.########", CultureInfo.InvariantCulture);
        }

        public static string NormalizeSide(string side)
        {
            var normalized = (side ?? string.Empty).Trim().ToLowerInvariant().Replace('-', '_').Replace(' ', '_');
            if (normalized == "top") normalized = "front";
            if (normalized == "bottom") normalized = "back";
            if (normalized != "right" && normalized != "left" && normalized != "front" && normalized != "back")
                throw new ArgumentException("clearance.side must be right, left, front, back, or power_connection.", nameof(side));
            return normalized;
        }

        private static void RequirePositiveFinite(double value, string name)
        {
            if (!Finite(value) || value <= 0) throw new ArgumentOutOfRangeException(name);
        }

        private static bool Finite(double value) => !double.IsNaN(value) && !double.IsInfinity(value);
    }
}
