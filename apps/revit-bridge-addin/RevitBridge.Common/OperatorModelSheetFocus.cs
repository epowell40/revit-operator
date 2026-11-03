using System;
using System.Collections.Generic;
using System.Linq;

namespace RevitBridge.Common
{
    // Native coordinate association, not a rendered-visibility or inspection verdict.
    public sealed class OperatorModelSheetFocus
    {
        public long elementId { get; set; }
        public string elementUniqueId { get; set; } = "";
        public long viewId { get; set; }
        public string viewUniqueId { get; set; } = "";
        public long viewportId { get; set; }
        public string viewportUniqueId { get; set; } = "";
        public long sheetId { get; set; }
        public string sheetUniqueId { get; set; } = "";
        public string coordinateSpace => "sheet_feet";
        public bool navigationOnly => true;
        public double[] boundsMinXyz { get; set; } = Array.Empty<double>();
        public double[] boundsMaxXyz { get; set; } = Array.Empty<double>();

        public static bool Vector(double[] p) => p != null && p.Length == 3 && p.All(n => !double.IsNaN(n) && !double.IsInfinity(n));
        public static OperatorModelSheetFocus? Unique(long sheet, long element, IEnumerable<OperatorModelSheetFocus> candidates, bool unresolved)
        {
            var rows = candidates.Take(129).ToArray();
            if (unresolved || sheet <= 0 || element <= 0 || rows.Length != 1) return null;
            var r = rows[0];
            if (r.sheetId != sheet || r.elementId != element || r.viewId <= 0 || r.viewportId <= 0
                || new[] {r.elementId,r.viewId,r.viewportId,r.sheetId}.Distinct().Count() != 4
                || new[] {r.elementUniqueId,r.viewUniqueId,r.viewportUniqueId,r.sheetUniqueId}.Any(s => string.IsNullOrWhiteSpace(s) || s.Length > 200)
                || new[] {r.elementUniqueId,r.viewUniqueId,r.viewportUniqueId,r.sheetUniqueId}.Distinct().Count() != 4
                || !Vector(r.boundsMinXyz) || !Vector(r.boundsMaxXyz)
                || r.boundsMinXyz[2] != 0 || r.boundsMaxXyz[2] != 0
                || r.boundsMinXyz[0] >= r.boundsMaxXyz[0] || r.boundsMinXyz[1] >= r.boundsMaxXyz[1]) return null;
            return r;
        }

        // Points are already transformed by Revit. Flatten projection depth only
        // after both native transforms: a sheet's display plane is XY at Z=0.
        public static double[][] Bounds(IEnumerable<double[]> transformedCorners)
        {
            var p = transformedCorners.Take(9).ToArray();
            if (p.Length != 8 || p.Any(v => !Vector(v))) throw new ArgumentException("Eight finite transformed box corners required.");
            var result = new[] {new[] {p.Min(v=>v[0]),p.Min(v=>v[1]),0d},new[] {p.Max(v=>v[0]),p.Max(v=>v[1]),0d}};
            if(result[0][0]>=result[1][0] || result[0][1]>=result[1][1]) throw new ArgumentException("Projected bounds have no area.");
            return result;
        }

        // Convex straight crop boundaries only. Reject nonconvex/curved/split
        // ambiguity upstream; bbox coverage must not be inferred from one center.
        public static bool InsideConvexBoundary(double[][] corners, double[][] polygon)
        {
            if(corners.Length!=8 || corners.Any(p=>!Vector(p)) || polygon.Length<3 || polygon.Length>32 || polygon.Any(p=>!Vector(p)))return false;
            double Cross(double[] a,double[] b,double[] p)=>(b[0]-a[0])*(p[1]-a[1])-(b[1]-a[1])*(p[0]-a[0]);
            var turns=Enumerable.Range(0,polygon.Length).Select(i=>Cross(polygon[i],polygon[(i+1)%polygon.Length],polygon[(i+2)%polygon.Length])).ToArray();
            if(turns.Any(v=>Math.Abs(v)<1e-12) || !(turns.All(v=>v>0)||turns.All(v=>v<0)))return false;
            var sign=Math.Sign(turns[0]);
            return corners.All(p=>Enumerable.Range(0,polygon.Length).All(i=>sign*Cross(polygon[i],polygon[(i+1)%polygon.Length],p)>=-1e-10));
        }
    }
}
