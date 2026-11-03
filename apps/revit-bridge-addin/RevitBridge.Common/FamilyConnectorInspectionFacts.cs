using System;
using System.Collections.Generic;
using System.Linq;

namespace RevitBridge.Common
{
    // Observation adapter only. No family edit, fitting, connectivity or placement authority.
    public interface IFamilyConnectorInspectionSource
    {
        string Shape { get; }
        string Domain { get; }
        string SystemClassification { get; }
        bool IsPrimary { get; }
        double[] Origin { get; }
        double[] Direction { get; }
        double[][] Axes { get; }
        double Radius { get; }
        double Width { get; }
        double Height { get; }
    }

    public static class FamilyConnectorInspectionFacts
    {
        public static void AddToSummary(IDictionary<string, object?> summary, IFamilyConnectorInspectionSource? source)
        {
            if (summary == null) throw new ArgumentNullException(nameof(summary));
            if (source != null) summary["connector"] = Observe(source);
        }

        public static object Observe(IFamilyConnectorInspectionSource source)
        {
            if (source == null) throw new ArgumentNullException(nameof(source));
            var shape = Capture(() => source.Shape, v => !string.IsNullOrWhiteSpace(v));
            var shapeName = shape["value"] as string;
            var round = string.Equals(shapeName, "Round", StringComparison.Ordinal);
            var rectangular = string.Equals(shapeName, "Rectangular", StringComparison.Ordinal)
                || string.Equals(shapeName, "Oval", StringComparison.Ordinal);
            var dimensionReason = shapeName == null ? "shape_unavailable" : "not_applicable";
            return new
            {
                coordinateSpace = "family_document_current_type",
                lengthUnit = "feet",
                vectorUnit = "unitless",
                axesOrder = new[] { "basisX", "basisY", "basisZ" },
                shape,
                domain = Capture(() => source.Domain, v => !string.IsNullOrWhiteSpace(v)),
                systemClassification = Capture(() => source.SystemClassification, v => !string.IsNullOrWhiteSpace(v)),
                isPrimary = Capture(() => source.IsPrimary, _ => true),
                origin = Capture(() => source.Origin, Vector),
                direction = Capture(() => source.Direction, Vector),
                axes = Capture(() => source.Axes, v => v != null && v.Length == 3 && v.All(Vector)),
                radius = round ? Capture(() => source.Radius, Positive) : Unavailable(dimensionReason),
                width = rectangular ? Capture(() => source.Width, Positive) : Unavailable(dimensionReason),
                height = rectangular ? Capture(() => source.Height, Positive) : Unavailable(dimensionReason)
            };
        }

        private static bool Finite(double v) => !double.IsNaN(v) && !double.IsInfinity(v);
        private static bool Positive(double v) => Finite(v) && v > 0;
        private static bool Vector(double[] v) => v != null && v.Length == 3 && v.All(Finite);

        private static Dictionary<string, object?> Capture<T>(Func<T> read, Func<T, bool> valid)
        {
            try
            {
                var value = read();
                return valid(value)
                    ? new Dictionary<string, object?> { ["available"] = true, ["value"] = value, ["reason"] = null, ["error"] = null }
                    : Unavailable("invalid_value");
            }
            catch (Exception ex) { return Unavailable("getter_failed", ex.Message); }
        }

        private static Dictionary<string, object?> Unavailable(string reason, string? error = null)
            => new Dictionary<string, object?> { ["available"] = false, ["value"] = null, ["reason"] = reason, ["error"] = error };
    }
}
