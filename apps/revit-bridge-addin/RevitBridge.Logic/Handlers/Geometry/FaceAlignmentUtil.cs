using System;
using System.Collections.Generic;
using System.Linq;
using Autodesk.Revit.DB;

namespace RevitBridge.Logic.Handlers
{
    internal static class FaceAlignmentUtil
    {
        internal sealed class ResolvedPlanarFace
        {
            public PlanarFace Face { get; set; } = null!;
            public XYZ Axis { get; set; } = XYZ.Zero;
            public string Side { get; set; } = "";
            public double AxisAlignmentAbs { get; set; }
            public double PlaneCoordOnAxis { get; set; }
            public XYZ LabelPoint { get; set; } = XYZ.Zero;
        }

        internal static XYZ ResolveAxis(View view, string axisToken)
        {
            var a = (axisToken ?? "").Trim();
            if (a.Equals("viewX", StringComparison.OrdinalIgnoreCase))
                return view.RightDirection.Normalize();
            if (a.Equals("viewY", StringComparison.OrdinalIgnoreCase))
                return view.UpDirection.Normalize();
            throw new ArgumentException($"Unsupported axis '{axisToken}'. Supported: viewX, viewY");
        }

        internal static void ValidateSideAxisCompatibility(string axisToken, string sideToken)
        {
            var axis = (axisToken ?? "").Trim().ToLowerInvariant();
            var side = (sideToken ?? "").Trim().ToLowerInvariant();
            if (axis == "viewx" && (side != "left" && side != "right"))
                throw new ArgumentException("For axis=viewX, side must be 'left' or 'right'.");
            if (axis == "viewy" && (side != "top" && side != "bottom"))
                throw new ArgumentException("For axis=viewY, side must be 'top' or 'bottom'.");
        }

        internal static bool TryResolvePlanarFace(Document doc, ElementId elementId, View view, XYZ axis, string axisToken, string sideToken, double minAbsNormalDot, out ResolvedPlanarFace? resolved, out string? error)
        {
            resolved = null;
            error = null;

            ValidateSideAxisCompatibility(axisToken, sideToken);

            var e = doc.GetElement(elementId);
            if (e == null)
            {
                error = $"Element {RevitBridge.Common.ElementIdCompat.GetValue(elementId)} not found.";
                return false;
            }

            var opts = new Options
            {
                ComputeReferences = true,
                IncludeNonVisibleObjects = false,
                View = view
            };

            GeometryElement? geom = null;
            try { geom = e.get_Geometry(opts); } catch { geom = null; }
            if (geom == null)
            {
                error = $"Failed to read geometry for element {RevitBridge.Common.ElementIdCompat.GetValue(elementId)}.";
                return false;
            }

            var candidates = new List<ResolvedPlanarFace>();
            foreach (var pf in EnumeratePlanarFaces(geom))
            {
                XYZ n;
                try { n = pf.FaceNormal.Normalize(); }
                catch { continue; }

                var alignment = Math.Abs(n.DotProduct(axis));
                if (!(alignment >= minAbsNormalDot)) continue;

                double coord;
                try { coord = pf.Origin.DotProduct(axis); }
                catch { continue; }

                XYZ labelPoint;
                try
                {
                    var bb = pf.GetBoundingBox();
                    var uv = (bb.Min + bb.Max) * 0.5;
                    labelPoint = pf.Evaluate(uv);
                }
                catch
                {
                    labelPoint = pf.Origin;
                }

                candidates.Add(new ResolvedPlanarFace
                {
                    Face = pf,
                    Axis = axis,
                    Side = sideToken,
                    AxisAlignmentAbs = alignment,
                    PlaneCoordOnAxis = coord,
                    LabelPoint = labelPoint
                });
            }

            if (candidates.Count == 0)
            {
                error = $"No planar face found for element {RevitBridge.Common.ElementIdCompat.GetValue(elementId)} aligned to {axisToken} (minAbsNormalDot={minAbsNormalDot:0.###}).";
                return false;
            }

            var side = (sideToken ?? "").Trim().ToLowerInvariant();
            ResolvedPlanarFace best;
            if (side == "left" || side == "bottom")
                best = candidates.OrderBy(c => c.PlaneCoordOnAxis).First();
            else
                best = candidates.OrderByDescending(c => c.PlaneCoordOnAxis).First();

            resolved = best;
            return true;
        }

        internal static IEnumerable<PlanarFace> EnumeratePlanarFaces(GeometryElement geom)
        {
            foreach (var s in EnumerateSolids(geom))
            {
                FaceArray? faces = null;
                try { faces = s.Faces; } catch { faces = null; }
                if (faces == null) continue;
                foreach (Face f in faces)
                {
                    if (f is PlanarFace pf) yield return pf;
                }
            }
        }

        internal static IEnumerable<Solid> EnumerateSolids(GeometryElement geom)
        {
            foreach (var obj in geom)
            {
                if (obj == null) continue;
                if (obj is Solid s)
                {
                    if (s.Volume > 1e-9) yield return s;
                    continue;
                }

                if (obj is GeometryInstance gi)
                {
                    GeometryElement? ig = null;
                    try { ig = gi.GetInstanceGeometry(); } catch { ig = null; }
                    if (ig != null)
                    {
                        foreach (var ss in EnumerateSolids(ig))
                            yield return ss;
                    }
                }
            }
        }
    }
}
