using System;
using System.Collections.Generic;
using System.Linq;
using Autodesk.Revit.DB;

namespace RevitBridge.Common
{
    // Drawing bounds may change when Revit evaluates view graphics. For views
    // with projection transforms, use the documented placement/rotation frame
    // as the translation anchor and leave drawing bounds as separate evidence.
    public static class SheetViewportPlacement
    {
        public static object Read(Viewport viewport)
        {
            var owner = ElementIdCompat.GetValue(viewport.OwnerViewId);
            if (viewport.HasViewportTransforms())
            {
                using (var frame = viewport.GetProjectionToSheetTransform())
                    return ProjectionAnchor(owner, Point(frame.Origin), Point(frame.BasisX), Point(frame.BasisY), Point(frame.BasisZ));
            }
            // Legends and other nonprojecting viewports retain their distinct
            // box-center contract; unavailable placement is never guessed.
            return new { kind = "ViewportBoxCenter", pointXyz = Point(viewport.GetBoxCenter()), ownerViewId = owner };
        }

        public static object ProjectionAnchor(long owner, double[] origin, double[] basisX, double[] basisY, double[] basisZ)
        {
            if (owner <= 0 || new[] { origin, basisX, basisY, basisZ }.Any(v => v == null || v.Length != 3 || v.Any(n => double.IsNaN(n) || double.IsInfinity(n))))
                throw new ArgumentException("A viewport placement requires an owning sheet and complete finite frame coordinates.");
            return new Dictionary<string, object>
            {
                ["kind"] = "ViewportProjectionOrigin", ["ownerViewId"] = owner,
                ["pointXyz"] = origin.ToArray(), ["basisXXyz"] = basisX.ToArray(),
                ["basisYXyz"] = basisY.ToArray(), ["basisZXyz"] = basisZ.ToArray()
            };
        }

        private static double[] Point(XYZ p) => new[] { p.X, p.Y, p.Z };
    }
}
