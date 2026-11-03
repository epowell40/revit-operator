using System;

namespace RevitBridge.Common
{
    /// <summary>An explicit CAD projection never asserts a complete inventory of
    /// unrelated native annotations, sketch elements or other view contents.</summary>
    public static class CadGeometryTargetReadContract
    {
        public static void Validate(bool? targetOnly, int viewCount, bool? includeGeometry, long? elementId, int? offset, int? viewInventoryLimit)
        {
            if (targetOnly != true) return; // Existing full-view inventory remains unchanged.
            if (viewCount != 1 || includeGeometry != true || !elementId.HasValue || elementId <= 0
                || !offset.HasValue || offset < 0 || offset > CadGeometryPageWindow.MaximumPrimitives || viewInventoryLimit.HasValue)
                throw new ArgumentException("cadTargetOnly requires exactly one owner view, includeCadGeometry=true, exact positive cadElementId and cadGeometryOffset; limit is a whole-view inventory option.");
        }
    }
}
