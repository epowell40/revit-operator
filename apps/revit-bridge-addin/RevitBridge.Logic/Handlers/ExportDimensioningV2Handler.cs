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
    public class ExportDimensioningV2Handler : IRequestHandler
    {
        public class Params
        {
            public long viewId { get; set; }
            public bool? includePotentialElements { get; set; } = true;
            public int? elementLimit { get; set; } = 20000;
        }

        private sealed class ViewBasis2d
        {
            private readonly XYZ _origin;
            private readonly XYZ _right;
            private readonly XYZ _up;

            public ViewBasis2d(View view)
            {
                _origin = view.Origin;
                _right = view.RightDirection.Normalize();
                _up = view.UpDirection.Normalize();
            }

            public (double x, double y) To2d(XYZ p)
            {
                var v = p - _origin;
                return (v.DotProduct(_right), v.DotProduct(_up));
            }
        }

        public Task<object> Handle(UIApplication app, string jsonData)
        {
            var p = string.IsNullOrEmpty(jsonData) ? new Params() : JsonSerializer.Deserialize<Params>(jsonData);
            if (p == null || p.viewId == 0)
                throw new ArgumentException("Missing required parameter: viewId");

            var doc = app.ActiveUIDocument.Document;
            var view = doc.GetElement(RevitBridge.Common.ElementIdCompat.Create(p.viewId)) as View;
            if (view == null)
                throw new ArgumentException($"View {p.viewId} not found");

            var basis2d = new ViewBasis2d(view);

            var wallStableKindCache = new Dictionary<long, Dictionary<string, string>>();
            var fiStableKindCache = new Dictionary<long, Dictionary<string, string>>();

            var referencedElementIds = new HashSet<long>();
            var dimExports = new List<object>();

            var dimCollector = new FilteredElementCollector(doc)
                .OfCategory(BuiltInCategory.OST_Dimensions)
                .WhereElementIsNotElementType()
                .WherePasses(new ElementOwnerViewFilter(view.Id));

            foreach (Dimension dim in dimCollector)
            {
                var stage = "init";
                try
                {
                    stage = "dimCurve";
                    Curve? dimCurve = null;
                    XYZ? dimMid = null;
                    try
                    {
                        dimCurve = dim.Curve;
                        dimMid = TryGetCurveMidpoint(dimCurve);
                    }
                    catch
                    {
                        // Ignore curve failures; we can still attempt ref resolution.
                    }

                    stage = "dimType";
                    var dimType = doc.GetElement(dim.GetTypeId()) as ElementType;

                    stage = "curve2d";
                    object? curve2d = null;
                    if (dimCurve != null)
                    {
                        if (TryGetCurveEndpoints(dimCurve, out var dp1, out var dp2))
                        {
                            var (x1, y1) = basis2d.To2d(dp1);
                            var (x2, y2) = basis2d.To2d(dp2);
                            curve2d = new
                            {
                                kind = dimCurve.GetType().Name,
                                p1 = new { x = x1, y = y1 },
                                p2 = new { x = x2, y = y2 }
                            };
                        }
                    }

                    stage = "refs";
                    var refs = new List<ResolvedRef>();
                    try
                    {
                        foreach (Reference r in dim.References)
                        {
                            var resolved = ResolveReference(doc, view, basis2d, dim, dimMid, r, wallStableKindCache, fiStableKindCache);
                            refs.Add(resolved);
                            if (resolved.elementId.HasValue) referencedElementIds.Add(resolved.elementId.Value);
                        }
                    }
                    catch
                    {
                        // Skip failing dimensions; keep export resilient.
                        continue;
                    }

                    stage = "order";
                    // Order references along dimension line (best-effort).
                    if (dimCurve is Line line && refs.Count > 1)
                    {
                        if (TryGetCurveEndpoints(line, out var lp1, out var lp2))
                        {
                            var (x1, y1) = basis2d.To2d(lp1);
                            var (x2, y2) = basis2d.To2d(lp2);
                            var dx = x2 - x1;
                            var dy = y2 - y1;
                            var len = Math.Sqrt(dx * dx + dy * dy);
                            if (len > 1e-9)
                            {
                                var ux = dx / len;
                                var uy = dy / len;
                                foreach (var rr in refs)
                                {
                                    if (rr.witnessPoint2d == null)
                                    {
                                        rr.order = null;
                                        continue;
                                    }
                                    var t = (rr.witnessPoint2d.x - x1) * ux + (rr.witnessPoint2d.y - y1) * uy;
                                    rr._t = t;
                                }

                                var ordered = refs.Where(r => r._t.HasValue).OrderBy(r => r._t!.Value).ToList();
                                for (var i = 0; i < ordered.Count; i++)
                                    ordered[i].order = i;
                            }
                        }
                    }

                    stage = "segments";
                    var segmentExports = new List<object>();
                    try
                    {
                        if (dim.Segments != null)
                        {
                            foreach (DimensionSegment seg in dim.Segments)
                            {
                                segmentExports.Add(new
                                {
                                    value = seg.Value,
                                    valueString = seg.ValueString
                                });
                            }
                        }
                    }
                    catch
                    {
                        // Ignore segments.
                    }

                    stage = "emit";
                    dimExports.Add(new
                    {
                        id = RevitBridge.Common.ElementIdCompat.GetValue(dim.Id),
                        typeId = RevitBridge.Common.ElementIdCompat.GetValue(dim.GetTypeId()),
                        typeName = dimType?.Name,
                        viewId = RevitBridge.Common.ElementIdCompat.GetValue(dim.OwnerViewId),
                        curve2d,
                        value = SafeGet(() => dim.Value),
                        valueString = SafeGet(() => dim.ValueString),
                        segments = segmentExports,
                        references = refs.Select(r => r.ToExportObject()).ToList()
                    });
                }
                catch (Exception ex)
                {
                    throw new Exception($"ExportDimensioningV2 failed for dimension {RevitBridge.Common.ElementIdCompat.GetValue(dim.Id)} at stage '{stage}'", ex);
                }
            }

            var elementIdsToExport = new HashSet<long>(referencedElementIds);
            if (p.includePotentialElements.GetValueOrDefault(true))
            {
                foreach (var id in CollectPotentialElements(doc, view, p.elementLimit ?? 20000))
                    elementIdsToExport.Add(id);
            }

            var elements = new List<object>();
            foreach (var id in elementIdsToExport)
            {
                var elem = doc.GetElement(RevitBridge.Common.ElementIdCompat.Create(id));
                if (elem == null) continue;
                elements.Add(ExportElement(doc, view, basis2d, elem));
            }

            var viewExport = ExportView(doc, view, basis2d);

            return Task.FromResult<object>(new
            {
                schema = "dimensioning_v2",
                exportedAtUtc = DateTime.UtcNow.ToString("o"),
                view = viewExport,
                elements,
                dimensions = dimExports
            });
        }

        private static bool TryGetCurveEndpoints(Curve c, out XYZ p1, out XYZ p2)
        {
            p1 = XYZ.Zero;
            p2 = XYZ.Zero;
            try
            {
                if (c.IsBound)
                {
                    p1 = c.GetEndPoint(0);
                    p2 = c.GetEndPoint(1);
                    return true;
                }
            }
            catch
            {
                // Ignore.
            }

            if (c is Line l)
            {
                try
                {
                    var o = l.Origin;
                    var d = l.Direction.Normalize();
                    var len = 200.0; // feet
                    p1 = o - d.Multiply(len);
                    p2 = o + d.Multiply(len);
                    return true;
                }
                catch
                {
                    return false;
                }
            }

            return false;
        }

        private static XYZ? TryGetCurveMidpoint(Curve? c)
        {
            if (c == null) return null;
            try
            {
                if (c.IsBound) return c.Evaluate(0.5, true);
            }
            catch
            {
                // Ignore.
            }

            if (c is Line l)
            {
                try { return l.Origin; } catch { return null; }
            }

            return null;
        }

        private static object ExportView(Document doc, View view, ViewBasis2d basis2d)
        {
            var origin = view.Origin;
            var right = view.RightDirection;
            var up = view.UpDirection;
            var dir = view.ViewDirection;

            object? crop = null;
            try
            {
                if (view.CropBoxActive)
                {
                    var cb = view.CropBox;
                    crop = new
                    {
                        enabled = true,
                        min = new { x = cb.Min.X, y = cb.Min.Y, z = cb.Min.Z },
                        max = new { x = cb.Max.X, y = cb.Max.Y, z = cb.Max.Z }
                    };
                }
                else
                {
                    crop = new { enabled = false };
                }
            }
            catch
            {
                crop = null;
            }

            string? lengthUnit = null;
            try
            {
                var u = doc.GetUnits();
                var fo = u.GetFormatOptions(SpecTypeId.Length);
                lengthUnit = fo?.GetUnitTypeId()?.TypeId;
            }
            catch
            {
                lengthUnit = null;
            }

            return new
            {
                id = RevitBridge.Common.ElementIdCompat.GetValue(view.Id),
                name = view.Name,
                type = view.ViewType.ToString(),
                scale = view.Scale,
                origin = new { x = origin.X, y = origin.Y, z = origin.Z },
                right = new { x = right.X, y = right.Y, z = right.Z },
                up = new { x = up.X, y = up.Y, z = up.Z },
                direction = new { x = dir.X, y = dir.Y, z = dir.Z },
                cropBox = crop,
                units = new { length = lengthUnit }
            };
        }

        private static IEnumerable<long> CollectPotentialElements(Document doc, View view, int limit)
        {
            var ids = new HashSet<long>();

            void AddCollector(Func<FilteredElementCollector> make)
            {
                if (ids.Count >= limit) return;
                foreach (var e in make().WhereElementIsNotElementType().ToElements())
                {
                    if (ids.Count >= limit) return;
                    ids.Add(RevitBridge.Common.ElementIdCompat.GetValue(e.Id));
                }
            }

            AddCollector(() => new FilteredElementCollector(doc, view.Id).OfCategory(BuiltInCategory.OST_Walls));
            AddCollector(() => new FilteredElementCollector(doc, view.Id).OfCategory(BuiltInCategory.OST_Grids));
            AddCollector(() => new FilteredElementCollector(doc, view.Id).OfCategory(BuiltInCategory.OST_Doors));
            AddCollector(() => new FilteredElementCollector(doc, view.Id).OfCategory(BuiltInCategory.OST_Windows));
            AddCollector(() => new FilteredElementCollector(doc, view.Id).OfCategory(BuiltInCategory.OST_GenericModel));
            AddCollector(() => new FilteredElementCollector(doc, view.Id).OfCategory(BuiltInCategory.OST_Columns));
            AddCollector(() => new FilteredElementCollector(doc, view.Id).OfCategory(BuiltInCategory.OST_StructuralColumns));

            AddCollector(() => new FilteredElementCollector(doc, view.Id).OfClass(typeof(ReferencePlane)));

            // Detail/model lines (view-specific CurveElements).
            try
            {
                foreach (CurveElement ce in new FilteredElementCollector(doc, view.Id).OfClass(typeof(CurveElement)))
                {
                    if (ids.Count >= limit) break;
                    if (ce.ViewSpecific) ids.Add(RevitBridge.Common.ElementIdCompat.GetValue(ce.Id));
                }
            }
            catch
            {
                // Ignore.
            }

            return ids;
        }

        private static object ExportElement(Document doc, View view, ViewBasis2d basis2d, Element e)
        {
            string? levelName = null;
            if (e.LevelId != ElementId.InvalidElementId)
            {
                var lvl = doc.GetElement(e.LevelId) as Level;
                levelName = lvl?.Name;
            }

            var typeElem = doc.GetElement(e.GetTypeId()) as ElementType;
            string? familyName = null;
            if (typeElem is FamilySymbol fs)
                familyName = fs.FamilyName;

            long? hostId = null;
            if (e is FamilyInstance fi && fi.Host != null)
                hostId = RevitBridge.Common.ElementIdCompat.GetValue(fi.Host.Id);

            object? geom2d = null;
            if (TryGetLineGeometry2d(e, view, basis2d, out var lineGeom))
            {
                geom2d = lineGeom;
            }
            else if (TryGetPointGeometry2d(e, basis2d, out var ptGeom))
            {
                geom2d = ptGeom;
            }

            object? bbox2d = null;
            if (TryGetBbox2d(e, view, basis2d, out var bb))
                bbox2d = bb;

            object? opening = null;
            if (e is FamilyInstance inst && (RevitBridge.Common.ElementIdCompat.GetValue(inst.Category?.Id) == (long)BuiltInCategory.OST_Doors || RevitBridge.Common.ElementIdCompat.GetValue(inst.Category?.Id) == (long)BuiltInCategory.OST_Windows))
            {
                var pt = inst.Location is LocationPoint lp ? lp.Point : null;
                if (pt != null)
                {
                    var (x, y) = basis2d.To2d(pt);
                    opening = new { insertion2d = new { x, y } };
                }
            }

            return new
            {
                id = RevitBridge.Common.ElementIdCompat.GetValue(e.Id),
                category = e.Category?.Name,
                categoryId = RevitBridge.Common.ElementIdCompat.GetValue(e.Category?.Id),
                elementType = e.GetType().Name,
                name = e.Name,
                typeName = typeElem?.Name,
                familyName,
                hostId,
                level = levelName,
                geom2d,
                bbox2d,
                opening
            };
        }

        private static bool TryGetPointGeometry2d(Element e, ViewBasis2d basis2d, out object geom2d)
        {
            geom2d = null;
            if (e.Location is LocationPoint lp)
            {
                var (x, y) = basis2d.To2d(lp.Point);
                geom2d = new { kind = "Point", p = new { x, y } };
                return true;
            }

            return false;
        }

        private static bool TryGetLineGeometry2d(Element e, View view, ViewBasis2d basis2d, out object geom2d)
        {
            geom2d = null;

            Curve? c = null;
            switch (e)
            {
                case Grid g:
                    c = GetBestDatumCurveInView(g, view) ?? g.Curve;
                    break;
                case Wall w when w.Location is LocationCurve lc:
                    c = lc.Curve;
                    break;
                case CurveElement ce:
                    c = ce.GeometryCurve;
                    break;
                case ReferencePlane rp:
                    try
                    {
                        c = Line.CreateBound(rp.BubbleEnd, rp.FreeEnd);
                    }
                    catch
                    {
                        c = null;
                    }
                    break;
            }

            if (c == null)
                return false;

            if (!TryGetCurveEndpoints(c, out var p1, out var p2))
                return false;
            var (x1, y1) = basis2d.To2d(p1);
            var (x2, y2) = basis2d.To2d(p2);
            geom2d = new { kind = c.GetType().Name, p1 = new { x = x1, y = y1 }, p2 = new { x = x2, y = y2 } };
            return true;
        }

        private static Curve? GetBestDatumCurveInView(DatumPlane datum, View view)
        {
            foreach (var extent in new[] { DatumExtentType.ViewSpecific, DatumExtentType.Model })
            {
                try
                {
                    var curves = datum.GetCurvesInView(extent, view);
                    if (curves == null || curves.Count == 0) continue;
                    var best = curves.FirstOrDefault(cc => cc != null && cc.IsBound);
                    if (best != null) return best;
                    return curves[0];
                }
                catch
                {
                    // Ignore.
                }
            }

            return null;
        }

        private static bool TryGetBbox2d(Element e, View view, ViewBasis2d basis2d, out object bbox2d)
        {
            bbox2d = null;
            BoundingBoxXYZ? bb = null;
            try { bb = e.get_BoundingBox(view); } catch { bb = null; }
            if (bb == null)
            {
                try { bb = e.get_BoundingBox(null); } catch { bb = null; }
            }
            if (bb == null) return false;

            var min = bb.Min;
            var max = bb.Max;
            var corners = new[]
            {
                new XYZ(min.X, min.Y, min.Z),
                new XYZ(min.X, min.Y, max.Z),
                new XYZ(min.X, max.Y, min.Z),
                new XYZ(min.X, max.Y, max.Z),
                new XYZ(max.X, min.Y, min.Z),
                new XYZ(max.X, min.Y, max.Z),
                new XYZ(max.X, max.Y, min.Z),
                new XYZ(max.X, max.Y, max.Z),
            };

            double minX = double.PositiveInfinity, minY = double.PositiveInfinity, maxX = double.NegativeInfinity, maxY = double.NegativeInfinity;
            foreach (var c in corners)
            {
                var (x, y) = basis2d.To2d(c);
                minX = Math.Min(minX, x);
                minY = Math.Min(minY, y);
                maxX = Math.Max(maxX, x);
                maxY = Math.Max(maxY, y);
            }

            bbox2d = new
            {
                min = new { x = minX, y = minY },
                max = new { x = maxX, y = maxY }
            };
            return true;
        }

        private sealed class ResolvedRef
        {
            public long? elementId { get; set; }
            public string? category { get; set; }
            public string? elementType { get; set; }
            public string? referenceKind { get; set; }
            public string? stableRepresentation { get; set; }
            public Witness2d? witnessPoint2d { get; set; }
            public int? order { get; set; }
            public double? _t { get; set; }
            public string? error { get; set; }

            public object ToExportObject() => new
            {
                elementId,
                category,
                elementType,
                referenceKind,
                witnessPoint2d = witnessPoint2d == null ? null : new { x = witnessPoint2d.x, y = witnessPoint2d.y },
                order,
                stableRepresentation,
                error
            };
        }

        private sealed class Witness2d
        {
            public double x { get; }
            public double y { get; }
            public Witness2d(double x, double y)
            {
                this.x = x;
                this.y = y;
            }
        }

        private static ResolvedRef ResolveReference(
            Document doc,
            View view,
            ViewBasis2d basis2d,
            Dimension dim,
            XYZ? dimMid,
            Reference r,
            Dictionary<long, Dictionary<string, string>> wallStableKindCache,
            Dictionary<long, Dictionary<string, string>> fiStableKindCache)
        {
            var rr = new ResolvedRef();
            try
            {
                var elem = doc.GetElement(r.ElementId);
                rr.elementId = RevitBridge.Common.ElementIdCompat.GetValue(elem?.Id);
                rr.category = elem?.Category?.Name;
                rr.elementType = elem?.GetType().Name;

                string? stable = null;
                try { stable = r.ConvertToStableRepresentation(doc); } catch { stable = null; }
                rr.stableRepresentation = stable;

                var witness3d = TryResolveWitnessPoint(doc, view, dim, r, dimMid);
                if (witness3d != null)
                {
                    var (x, y) = basis2d.To2d(witness3d);
                    rr.witnessPoint2d = new Witness2d(x, y);
                }

                rr.referenceKind = DetermineReferenceKind(doc, elem, stable, r, witness3d, wallStableKindCache, fiStableKindCache);
            }
            catch (Exception ex)
            {
                rr.error = ex.Message;
            }
            return rr;
        }

        private static XYZ? TryResolveWitnessPoint(Document doc, View view, Dimension dim, Reference r, XYZ? dimMid)
        {
            // 1) Reference.GlobalPoint (when available)
            try
            {
                var gp = r.GlobalPoint;
                if (gp != null) return gp;
            }
            catch
            {
                // Ignore.
            }

            var elem = doc.GetElement(r.ElementId);
            if (elem == null)
                return null;

            // 2) Resolve geometry object from reference.
            try
            {
                var geomObj = elem.GetGeometryObjectFromReference(r);
                var mid = dimMid;
                if (mid == null)
                {
                    try { mid = dim.Curve?.Evaluate(0.5, true); } catch { mid = null; }
                }

                if (geomObj is Autodesk.Revit.DB.Point ptObj)
                    return ptObj.Coord;

                if (mid != null)
                {
                    if (geomObj is Edge edge)
                    {
                        var c = edge.AsCurve();
                        var ir = c.Project(mid);
                        if (ir?.XYZPoint != null) return ir.XYZPoint;
                        return c.Evaluate(0.5, true);
                    }

                    if (geomObj is Curve c2)
                    {
                        var ir = c2.Project(mid);
                        if (ir?.XYZPoint != null) return ir.XYZPoint;
                        return c2.Evaluate(0.5, true);
                    }

                    if (geomObj is Face f)
                    {
                        var ir = f.Project(mid);
                        if (ir?.XYZPoint != null) return ir.XYZPoint;
                    }
                }
            }
            catch
            {
                // Ignore and fallback.
            }

            // 3) Fallback to element location / bbox center.
            if (elem.Location is LocationPoint lp)
                return lp.Point;

            if (elem.Location is LocationCurve lc)
                return lc.Curve.Evaluate(0.5, true);

            try
            {
                var bb = elem.get_BoundingBox(view) ?? elem.get_BoundingBox(null);
                if (bb != null) return (bb.Min + bb.Max) * 0.5;
            }
            catch
            {
                // Ignore.
            }

            return null;
        }

        private static string? DetermineReferenceKind(
            Document doc,
            Element? elem,
            string? stable,
            Reference reference,
            XYZ? witness3d,
            Dictionary<long, Dictionary<string, string>> wallStableKindCache,
            Dictionary<long, Dictionary<string, string>> fiStableKindCache)
        {
            if (elem == null) return null;

            if (elem is Wall wall)
            {
                var map = GetWallStableKindMap(doc, wall, wallStableKindCache);
                if (!string.IsNullOrEmpty(stable) && map.TryGetValue(stable, out var kind))
                    return kind;
                var inferred = TryInferWallFaceKind(doc, wall, map, stable, reference, witness3d);
                if (!string.IsNullOrEmpty(inferred))
                    return inferred;
                return "wallCenterline";
            }

            if (elem is Grid)
                return "gridLine";

            if (elem is ReferencePlane)
                return "refPlane";

            if (elem is CurveElement ce)
                return ce.ViewSpecific ? "detailLine" : "modelLine";

            if (elem is FamilyInstance fi && (RevitBridge.Common.ElementIdCompat.GetValue(fi.Category?.Id) == (long)BuiltInCategory.OST_Doors || RevitBridge.Common.ElementIdCompat.GetValue(fi.Category?.Id) == (long)BuiltInCategory.OST_Windows))
            {
                var map = GetFamilyInstanceStableKindMap(doc, fi, fiStableKindCache);
                if (!string.IsNullOrEmpty(stable) && map.TryGetValue(stable, out var kind))
                    return kind;
                return "openingRef";
            }

            return "elementRef";
        }

        private static Dictionary<string, string> GetWallStableKindMap(Document doc, Wall wall, Dictionary<long, Dictionary<string, string>> cache)
        {
            if (cache.TryGetValue(RevitBridge.Common.ElementIdCompat.GetValue(wall.Id), out var map))
                return map;

            map = new Dictionary<string, string>();
            cache[RevitBridge.Common.ElementIdCompat.GetValue(wall.Id)] = map;

            void AddFaces(ShellLayerType shell, string kind)
            {
                try
                {
                    var refs = HostObjectUtils.GetSideFaces(wall, shell);
                    foreach (var r in refs)
                    {
                        try
                        {
                            var stable = r.ConvertToStableRepresentation(doc);
                            if (!map.ContainsKey(stable))
                                map[stable] = kind;
                        }
                        catch
                        {
                            // Ignore.
                        }
                    }
                }
                catch
                {
                    // Ignore.
                }
            }

            AddFaces(ShellLayerType.Exterior, "wallFaceExterior");
            AddFaces(ShellLayerType.Interior, "wallFaceInterior");

            return map;
        }

        private static string? TryInferWallFaceKind(Document doc, Wall wall, Dictionary<string, string> stableKindMap, string? stable, Reference reference, XYZ? witness3d)
        {
            if (witness3d == null)
                return null;

            if (!(wall.Location is LocationCurve lc))
                return null;

            GeometryObject? geomObj = null;
            try { geomObj = wall.GetGeometryObjectFromReference(reference); } catch { geomObj = null; }
            if (!(geomObj is PlanarFace pf))
                return null;

            var wallNormal = wall.Orientation;
            if (wallNormal == null || wallNormal.GetLength() < 1e-9)
                return null;
            wallNormal = wallNormal.Normalize();

            var faceNormal = pf.FaceNormal;
            if (faceNormal == null || faceNormal.GetLength() < 1e-9)
                return null;
            faceNormal = faceNormal.Normalize();

            var isExterior = faceNormal.DotProduct(wallNormal) > 0;

            var mid = lc.Curve.Evaluate(0.5, true);
            var offset = Math.Abs((witness3d - mid).DotProduct(wallNormal));

            var totalHalf = wall.Width / 2.0;
            var kind = isExterior ? "wallFaceExterior" : "wallFaceInterior";

            if (TryGetWallCoreOffsets(wall, out var coreExteriorOffset, out var coreInteriorOffset))
            {
                var coreOffset = isExterior ? coreExteriorOffset : coreInteriorOffset;
                var dCore = Math.Abs(offset - coreOffset);
                var dFinish = Math.Abs(offset - totalHalf);
                if (dCore + 0.01 < dFinish)
                    kind = isExterior ? "wallCoreFaceExterior" : "wallCoreFaceInterior";
            }

            if (!string.IsNullOrEmpty(stable) && !stableKindMap.ContainsKey(stable))
                stableKindMap[stable] = kind;

            return kind;
        }

        private static bool TryGetWallCoreOffsets(Wall wall, out double coreExteriorOffset, out double coreInteriorOffset)
        {
            coreExteriorOffset = 0;
            coreInteriorOffset = 0;

            CompoundStructure? cs = null;
            try { cs = wall.WallType?.GetCompoundStructure(); } catch { cs = null; }
            if (cs == null) return false;

            int firstCore;
            int lastCore;
            try
            {
                firstCore = cs.GetFirstCoreLayerIndex();
                lastCore = cs.GetLastCoreLayerIndex();
            }
            catch
            {
                return false;
            }

            if (firstCore < 0 || lastCore < 0 || lastCore < firstCore)
                return false;

            double total = 0.0;
            double shellExt = 0.0;
            double shellInt = 0.0;

            int layerCount;
            try { layerCount = cs.LayerCount; } catch { return false; }
            for (var i = 0; i < layerCount; i++)
            {
                double w;
                try { w = cs.GetLayerWidth(i); } catch { w = 0.0; }
                total += w;
                if (i < firstCore) shellExt += w;
                if (i > lastCore) shellInt += w;
            }

            if (total <= 1e-9) return false;
            var totalHalf = total / 2.0;
            coreExteriorOffset = Math.Max(0.0, totalHalf - shellExt);
            coreInteriorOffset = Math.Max(0.0, totalHalf - shellInt);
            return true;
        }

        private static Dictionary<string, string> GetFamilyInstanceStableKindMap(Document doc, FamilyInstance fi, Dictionary<long, Dictionary<string, string>> cache)
        {
            if (cache.TryGetValue(RevitBridge.Common.ElementIdCompat.GetValue(fi.Id), out var map))
                return map;

            map = new Dictionary<string, string>();
            cache[RevitBridge.Common.ElementIdCompat.GetValue(fi.Id)] = map;

            void AddRefs(FamilyInstanceReferenceType t, string kind)
            {
                try
                {
                    var refs = fi.GetReferences(t);
                    if (refs == null) return;
                    foreach (var r in refs)
                    {
                        try
                        {
                            var stable = r.ConvertToStableRepresentation(doc);
                            if (!map.ContainsKey(stable))
                                map[stable] = kind;
                        }
                        catch
                        {
                            // Ignore.
                        }
                    }
                }
                catch
                {
                    // Ignore.
                }
            }

            AddRefs(FamilyInstanceReferenceType.Left, "openingEdgeLeft");
            AddRefs(FamilyInstanceReferenceType.Right, "openingEdgeRight");
            AddRefs(FamilyInstanceReferenceType.CenterLeftRight, "openingCenter");

            return map;
        }

        private static T? SafeGet<T>(Func<T> f)
        {
            try { return f(); } catch { return default; }
        }
    }
}
