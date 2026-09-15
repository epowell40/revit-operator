using System;

namespace RevitBridge.Common
{
    public static class MepDuctProfilePolicy
    {
        // Validate the requested profile before a native transaction. An oval
        // uses width/height, while a round profile requires a diameter.
        public static string Resolve(string? requestedShape, double? widthFt, double? heightFt, double? diameterFt)
        {
            var shape = (requestedShape ?? string.Empty).Trim().ToLowerInvariant();
            if (shape == "rectangle") shape = "rectangular";
            if (shape.Length > 0 && shape != "round" && shape != "rectangular" && shape != "oval")
                throw new ArgumentException("ductShape must be round, rectangular, or oval.");
            foreach (var value in new[] { widthFt, heightFt, diameterFt })
                if (value.HasValue && (double.IsNaN(value.Value) || double.IsInfinity(value.Value) || value.Value <= 0))
                    throw new ArgumentException("Duct dimensions must be finite positive lengths.");
            var rectangularSize = widthFt.HasValue && heightFt.HasValue && !diameterFt.HasValue;
            var roundSize = diameterFt.HasValue && !widthFt.HasValue && !heightFt.HasValue;
            if (!rectangularSize && !roundSize)
                throw new ArgumentException("Provide a valid width and height or a diameter for every duct segment.");
            if (shape.Length == 0) return roundSize ? "round" : "rectangular";
            if (shape == "round" ? !roundSize : !rectangularSize)
                throw new ArgumentException($"The supplied dimensions do not match ductShape '{shape}'.");
            return shape;
        }
    }
}
