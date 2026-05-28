using System;
using System.Collections.Generic;
using System.Linq;
using System.Text.Json;
using System.Threading.Tasks;
using Autodesk.Revit.DB;
using Autodesk.Revit.UI;
using RevitBridge.Common;

namespace RevitBridge.Logic.Handlers
{
    public class CreateDimensionHandler : IRequestHandler
    {
        private class RefItem
        {
            public Reference Reference { get; set; }
            public XYZ Point { get; set; }
            public ElementId ElementId { get; set; }
        }

        public class DimensionRequest
        {
            public long viewId { get; set; }
            public List<long> elementIds { get; set; }
            public SimplePoint startPoint { get; set; }
            public SimplePoint endPoint { get; set; }
        }

        public class SimplePoint
        {
            public double x { get; set; }
            public double y { get; set; }
            public double z { get; set; }
        }

        public Task<object> Handle(UIApplication app, string jsonData)
        {
            var request = JsonSerializer.Deserialize<DimensionRequest>(jsonData);
            var doc = app.ActiveUIDocument.Document;
            var view = doc.GetElement(RevitBridge.Common.ElementIdCompat.Create(request.viewId)) as View;

            if (view == null) return Task.FromResult<object>(new { error = "View not found" });

            using (Transaction tx = new Transaction(doc, "Create Dimension"))
            {
                tx.Start();

                var refItems = new List<RefItem>();
                var fallbackPoints = new List<XYZ>();
                var curveRefOptions = new Options
                {
                    ComputeReferences = true,
                    IncludeNonVisibleObjects = true,
                    View = view
                };

                var uniqueIds = new List<long>();
                var seen = new HashSet<long>();
                foreach (var id in request.elementIds ?? new List<long>())
                {
                    if (!seen.Add(id)) continue;
                    uniqueIds.Add(id);
                }

                foreach (var id in uniqueIds)
                {
                    Element el = doc.GetElement(RevitBridge.Common.ElementIdCompat.Create(id));
                    if (el == null) continue;

                    if (el is Grid grid)
                    {
                        var r = new Reference(grid);
                        XYZ p = null;
                        try { p = grid.Curve.Evaluate(0.5, true); } catch { }
                        refItems.Add(new RefItem { Reference = r, Point = p ?? grid.Curve.GetEndPoint(0), ElementId = grid.Id });
                        fallbackPoints.Add(p ?? grid.Curve.GetEndPoint(0));
                    }
                    else if (el is CurveElement curveEl)
                    {
                        try
                        {
                            var curve = curveEl.GeometryCurve;
                            if (curve != null)
                            {
                                Reference curveRef = null;
                                try { curveRef = curve.Reference; } catch { /* ignore */ }
                                if (curveRef == null)
                                {
                                    try { curveRef = curve.GetEndPointReference(0); } catch { /* ignore */ }
                                }
                                if (curveRef == null)
                                {
                                    try { curveRef = curve.GetEndPointReference(1); } catch { /* ignore */ }
                                }
                                if (curveRef == null)
                                {
                                    try
                                    {
                                        var geom = curveEl.get_Geometry(curveRefOptions);
                                        if (geom != null)
                                        {
                                            foreach (var obj in geom)
                                            {
                                                if (obj is Curve c)
                                                {
                                                    curveRef = c.Reference;
                                                    break;
                                                }
                                            }
                                        }
                                    }
                                    catch { /* ignore */ }
                                }

                                if (curveRef == null)
                                {
                                    // As a last resort, try the element reference. Some curve elements may not support this.
                                    try { curveRef = new Reference(curveEl); } catch { /* ignore */ }
                                }

                                XYZ mid = null;
                                try { mid = curve.Evaluate(0.5, true); } catch { /* ignore */ }

                                if (curveRef != null)
                                {
                                    refItems.Add(new RefItem { Reference = curveRef, Point = mid, ElementId = curveEl.Id });
                                }
                                if (mid != null) fallbackPoints.Add(mid);
                            }
                            else
                            {
                                try
                                {
                                    var r = new Reference(curveEl);
                                    refItems.Add(new RefItem { Reference = r, Point = null, ElementId = curveEl.Id });
                                }
                                catch { /* ignore */ }
                            }
                        }
                        catch
                        {
                            try
                            {
                                var r = new Reference(curveEl);
                                refItems.Add(new RefItem { Reference = r, Point = null, ElementId = curveEl.Id });
                            }
                            catch { /* ignore */ }
                        }
                    }
                    else if (el is Wall wall)
                    {
                        IList<Reference> sideFaces = HostObjectUtils.GetSideFaces(wall, ShellLayerType.Exterior);
                        if (sideFaces.Count > 0)
                        {
                            refItems.Add(new RefItem { Reference = sideFaces[0], Point = null, ElementId = wall.Id });
                            LocationCurve locCurve = wall.Location as LocationCurve;
                            if (locCurve != null)
                            {
                                try { fallbackPoints.Add(locCurve.Curve.Evaluate(0.5, true)); } catch { /* ignore */ }
                            }
                        }
                        else
                        {
                            refItems.Add(new RefItem { Reference = new Reference(wall), Point = null, ElementId = wall.Id });
                            LocationCurve locCurve = wall.Location as LocationCurve;
                            if (locCurve != null)
                            {
                                try { fallbackPoints.Add(locCurve.Curve.Evaluate(0.5, true)); } catch { /* ignore */ }
                            }
                        }
                    }
                }

                // De-dupe by element id to avoid repeated refs (often causes invalid/zero dimensions).
                var deduped = new List<RefItem>();
                var seenElem = new HashSet<long>();
                foreach (var ri in refItems)
                {
                    if (ri?.Reference == null) continue;
                    long eid = RevitBridge.Common.ElementIdCompat.GetValue(ri.ElementId);
                    if (eid > 0 && !seenElem.Add(eid)) continue;
                    deduped.Add(ri);
                }
                refItems = deduped;

                if (refItems.Count < 2)
                {
                    tx.RollBack();
                    return Task.FromResult<object>(new { error = "Not enough valid references found" });
                }

                Line line;
                if (request.startPoint != null && request.endPoint != null)
                {
                    line = Line.CreateBound(
                        new XYZ(request.startPoint.x, request.startPoint.y, request.startPoint.z),
                        new XYZ(request.endPoint.x, request.endPoint.y, request.endPoint.z)
                    );
                }
                else
                {
                    // Fallback logic
                    if (fallbackPoints.Count < 2)
                    {
                        tx.RollBack();
                        return Task.FromResult<object>(new { error = "Not enough reference points to infer a dimension line" });
                    }

                    XYZ p1 = fallbackPoints[0];
                    XYZ p2 = fallbackPoints[1];
                    double dx = Math.Abs(p1.X - p2.X);
                    double dy = Math.Abs(p1.Y - p2.Y);
                    
                    if (dx > dy)
                    {
                        line = Line.CreateBound(new XYZ(p1.X, p1.Y + 10, p1.Z), new XYZ(p2.X, p1.Y + 10, p1.Z));
                    }
                    else
                    {
                        line = Line.CreateBound(new XYZ(p1.X + 10, p1.Y, p1.Z), new XYZ(p1.X + 10, p2.Y, p1.Z));
                    }
                }

                try
                {
                    // If caller provided an explicit dimension line, choose the nearest wall side-face reference
                    // (Interior vs Exterior) per wall, to avoid dimensions snapping to the wrong side.
                    if (request.startPoint != null && request.endPoint != null)
                    {
                        var probe = line.Evaluate(0.5, true);
                        for (int i = 0; i < refItems.Count; i++)
                        {
                            var ri = refItems[i];
                            var el0 = doc.GetElement(ri.Reference.ElementId);
                            if (el0 is Wall wall)
                            {
                                Reference bestRef = null;
                                double bestDist = double.PositiveInfinity;

                                foreach (var side in new[] { ShellLayerType.Exterior, ShellLayerType.Interior })
                                {
                                    IList<Reference> sideFaces = HostObjectUtils.GetSideFaces(wall, side);
                                    foreach (var faceRef in sideFaces)
                                    {
                                        try
                                        {
                                            var face = wall.GetGeometryObjectFromReference(faceRef) as Face;
                                            if (face == null) continue;
                                            var proj = face.Project(probe);
                                            if (proj == null) continue;
                                            double d = Math.Abs(proj.Distance);
                                            if (d < bestDist)
                                            {
                                                bestDist = d;
                                                bestRef = faceRef;
                                            }
                                        }
                                        catch
                                        {
                                            // ignore
                                        }
                                    }
                                }

                                ri.Reference = bestRef ?? ri.Reference;
                                try
                                {
                                    // Use the projection point to support sorting along the dimension line.
                                    var face = wall.GetGeometryObjectFromReference(ri.Reference) as Face;
                                    var proj = face?.Project(probe);
                                    if (proj != null) ri.Point = proj.XYZPoint;
                                }
                                catch { /* ignore */ }
                            }
                        }
                    }

                    // Populate missing points for sorting, then sort references along the dimension line direction.
                    XYZ origin = null;
                    XYZ dir = null;
                    try
                    {
                        origin = line.GetEndPoint(0);
                        dir = line.Direction.Normalize();
                    }
                    catch { /* ignore */ }

                    if (origin != null && dir != null)
                    {
                        foreach (var ri in refItems)
                        {
                            if (ri.Point != null) continue;
                            var e = doc.GetElement(ri.Reference.ElementId);
                            if (e is Grid g)
                            {
                                try { ri.Point = g.Curve.Evaluate(0.5, true); } catch { /* ignore */ }
                            }
                            else if (e is Wall w)
                            {
                                var lc = w.Location as LocationCurve;
                                if (lc != null)
                                {
                                    try { ri.Point = lc.Curve.Evaluate(0.5, true); } catch { /* ignore */ }
                                }
                            }
                        }

                        refItems = refItems
                            .OrderBy(ri =>
                            {
                                if (ri.Point == null) return double.PositiveInfinity;
                                try { return dir.DotProduct(ri.Point - origin); }
                                catch { return double.PositiveInfinity; }
                            })
                            .ToList();
                    }

                    var refArray = new ReferenceArray();
                    foreach (var ri in refItems)
                    {
                        if (ri?.Reference != null) refArray.Append(ri.Reference);
                    }

                    if (refArray.Size < 2)
                    {
                        tx.RollBack();
                        return Task.FromResult<object>(new { error = "Not enough valid references found (post-processing)" });
                    }

                    Dimension dim = doc.Create.NewDimension(view, line, refArray);

                    // Reject zero-length dimensions (these show up as 0" and are not acceptable output).
                    bool isZero = false;
                    try
                    {
                        if (dim.Segments != null && dim.Segments.Size > 0)
                        {
                            foreach (DimensionSegment s in dim.Segments)
                            {
                                var v = s.Value;
                                if (v.HasValue && Math.Abs(v.Value) < 1e-6) { isZero = true; break; }
                            }
                        }
                        else
                        {
                            var v = dim.Value;
                            if (v.HasValue && Math.Abs(v.Value) < 1e-6) isZero = true;
                        }
                    }
                    catch { /* ignore */ }

                    if (isZero)
                    {
                        tx.RollBack();
                        return Task.FromResult<object>(new { error = "Zero-length dimension rejected" });
                    }

                    tx.Commit();
                    return Task.FromResult<object>(new { success = true, id = RevitBridge.Common.ElementIdCompat.GetValue(dim.Id) });
                }
                catch (Exception ex)
                {
                    tx.RollBack();
                    return Task.FromResult<object>(new { error = ex.Message });
                }
            }
        }
    }
}

