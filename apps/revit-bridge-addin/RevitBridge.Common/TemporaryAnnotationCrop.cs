using System;
using System.Collections.Generic;

namespace RevitBridge.Common
{
    public interface ITemporaryAnnotationCropSettings
    {
        bool Supported { get; }
        bool CanActivate { get; }
        bool Active { get; set; }
        double Left { get; set; }
        double Right { get; set; }
        double Top { get; set; }
        double Bottom { get; set; }
    }

    /// <summary>Margins are paper/view feet. The caller must roll back its
    /// temporary transaction after export, including on partial failure.</summary>
    public static class TemporaryAnnotationCrop
    {
        public const double MinimumOffsetViewFt = 1.0 / 96.0;
        public static bool TryConfigure(ITemporaryAnnotationCropSettings settings, double marginViewFt, IList<string> warnings)
        {
            try
            {
                if (double.IsNaN(marginViewFt) || double.IsInfinity(marginViewFt) || marginViewFt < 0)
                    throw new ArgumentOutOfRangeException(nameof(marginViewFt));
                if (!settings.Supported)
                {
                    warnings.Add("The export view does not support annotation cropping; distant annotations may remain visible.");
                    return false;
                }
                if (!settings.Active)
                {
                    if (!settings.CanActivate) throw new InvalidOperationException("The annotation-crop setting is read-only.");
                    settings.Active = true;
                }
                var offset = Math.Max(MinimumOffsetViewFt, marginViewFt);
                settings.Left = offset; settings.Right = offset; settings.Top = offset; settings.Bottom = offset;
                if (!settings.Active || !Matches(settings.Left, offset) || !Matches(settings.Right, offset)
                    || !Matches(settings.Top, offset) || !Matches(settings.Bottom, offset))
                    throw new InvalidOperationException("Annotation-crop readback does not match the requested export bounds.");
                return true;
            }
            catch (Exception error)
            {
                warnings.Add("Could not bound annotations for the temporary export: " + error.Message);
                return false;
            }
        }
        private static bool Matches(double actual, double expected)
        {
            return !double.IsNaN(actual) && !double.IsInfinity(actual) && Math.Abs(actual - expected) <= 1e-9;
        }
    }
}
