using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Text.Json;
using System.Text.RegularExpressions;
using System.Threading.Tasks;
using Autodesk.Revit.DB;
using Autodesk.Revit.DB.Architecture;
using Autodesk.Revit.DB.Mechanical;
using Autodesk.Revit.UI;
using RevitBridge.Common;
using RevitBridge.Logic.Handlers;

namespace RevitBridge.Logic.Handlers.MEP
{
    public class RoomMepIntersectHandler : IRequestHandler
    {
        private const double CoordTolerance = 1e-6;
        private const double SizeTolerance = 1e-5;

        public sealed class Params
        {
            public string roomNumber { get; set; } = "";
            public string plenumTopLevelName { get; set; } = "";
            public List<string>? categories { get; set; }
            public string? systemClassification { get; set; }
            public string? sizeEquals { get; set; }
            public string intersectMode { get; set; } = "bbox"; // bbox | centerline
            public double? verticalTolerance { get; set; }
            public int? limit { get; set; } = 30000;
        }

        public Task<object> Handle(UIApplication app, string jsonData)
        {
            var p = string.IsNullOrWhiteSpace(jsonData) ? new Params() : JsonSerializer.Deserialize<Params>(jsonData) ?? new Params();

            var warnings = new List<string>();

            var roomNumber = (p.roomNumber ?? "").Trim();
            if (roomNumber.Length == 0) throw new ArgumentException("roomNumber is required.");

            var levelName = (p.plenumTopLevelName ?? "").Trim();
            if (levelName.Length == 0) throw new ArgumentException("plenumTopLevelName is required.");

            var mode = (p.intersectMode ?? "bbox").Trim().ToLowerInvariant();
            if (string.IsNullOrWhiteSpace(mode)) mode = "bbox";
            if (mode == "bboxintersect") mode = "bbox";
            if (mode == "centerlineintersect") mode = "centerline";
            if (mode != "bbox" && mode != "centerline")
                throw new ArgumentException("intersectMode must be 'bbox' or 'centerline'.");

            var categories = (p.categories == null || p.categories.Count == 0)
                ? new List<string> { "OST_DuctCurves", "OST_DuctFitting", "OST_DuctTerminal" }
                : p.categories.Where(x => !string.IsNullOrWhiteSpace(x)).Select(x => x!.Trim()).ToList();

            var bicList = new List<BuiltInCategory>();
            var unknownCategories = new List<string>();
            BuiltInCategoryTokenUtil.ParseMany(categories, bicList, unknownCategories);
            if (bicList.Count == 0) throw new InvalidOperationException("No valid categories were provided.");

            var uidoc = app.ActiveUIDocument;
            if (uidoc == null) throw new InvalidOperationException("No active UI document.");
            var doc = uidoc.Document;

            var systemFilter = (p.systemClassification ?? "").Trim();
            var sizeFilter = (p.sizeEquals ?? "").Trim();
            double? targetSizeFt = null;
            if (sizeFilter.Length > 0)
            {
                if (!TryParseLengthLoose(doc, sizeFilter, out var parsedSize, out var parseErr))
                    throw new InvalidOperationException($"Could not parse sizeEquals: {parseErr}");
                targetSizeFt = parsedSize;
            }

            var spatial = FindSpatialElementByNumber(doc, roomNumber);
            if (spatial == null) throw new InvalidOperationException($"Room/Space '{roomNumber}' not found.");

            var level = ResolveLevelByName(doc, levelName);
            if (level == null) throw new InvalidOperationException($"Level '{levelName}' not found.");

            if (!TryGetSpatialBaseAndTopZ(spatial, out var roomBaseZ, out var roomTopZ))
                warnings.Add("Could not compute room vertical range from spatial properties. Falling back to bounding box.");

            var roomBbox = spatial.get_BoundingBox(null);
            if (roomBbox == null) throw new InvalidOperationException($"Could not read bounding box for {GetSpatialKind(spatial)} '{roomNumber}'.");

            var footprint = GetSpatialFootprint(spatial);
            var usedBoundaryFootprint = footprint.Count >= 3;
            if (!usedBoundaryFootprint)
            {
                warnings.Add("Room boundary could not be resolved; using room bounding box XY projection.");
                footprint = new List<XYZ>
                {
                    new(roomBbox.Min.X, roomBbox.Min.Y, 0),
                    new(roomBbox.Max.X, roomBbox.Min.Y, 0),
                    new(roomBbox.Max.X, roomBbox.Max.Y, 0),
                    new(roomBbox.Min.X, roomBbox.Max.Y, 0)
                };
            }

            if (!roomBaseZ.HasValue) roomBaseZ = roomBbox.Min.Z;
            if (!roomTopZ.HasValue) roomTopZ = roomBbox.Max.Z;

            var tol = Math.Max(0.0, p.verticalTolerance ?? 0.0);
            var plenumMaxZ = Math.Max(roomTopZ.Value, level.Elevation) + tol;
            var plenumMinZ = roomTopZ.Value - tol;

            var (minX, maxX, minY, maxY) = Bounds(footprint);
            if (double.IsNaN(minX) || double.IsNaN(maxX) || double.IsNaN(minY) || double.IsNaN(maxY))
            {
                throw new InvalidOperationException("Could not compute room footprint bounds.");
            }

            var plenumMin = new XYZ(minX, minY, plenumMinZ);
            var plenumMax = new XYZ(maxX, maxY, plenumMaxZ);
            var roomDebugBbox = new { min = ToPoint(roomBbox.Min), max = ToPoint(roomBbox.Max) };
            var plenumDebugBbox = new { min = ToPoint(plenumMin), max = ToPoint(plenumMax) };

            var outline = new Outline(plenumMin, plenumMax);
            var collector = new FilteredElementCollector(doc).WhereElementIsNotElementType();
            if (bicList.Count == 1) collector.OfCategory(bicList[0]);
            else collector.WherePasses(new ElementMulticategoryFilter(bicList));
            collector.WherePasses(new BoundingBoxIntersectsFilter(outline));

            var byCategoryCounts = new Dictionary<string, int>(StringComparer.OrdinalIgnoreCase);
            var matches = new HashSet<long>();
            var scanned = 0;
            var max = p.limit.HasValue && p.limit.Value > 0 ? Math.Min(p.limit.Value, 100000) : 30000;

            foreach (var e in collector)
            {
                if (e == null) continue;
                if (e.Id == spatial.Id) continue;

                scanned++;
                if (scanned > max)
                {
                    warnings.Add($"Scan limit reached ({max}); results may be incomplete.");
                    break;
                }

                if (!string.IsNullOrWhiteSpace(systemFilter))
                {
                    if (!MatchesSystemClassification(e, systemFilter))
                        continue;
                }

                if (targetSizeFt.HasValue)
                {
                    if (!MatchesSizeFilter(doc, e, targetSizeFt.Value))
                        continue;
                }

                bool intersects;
                if (mode == "centerline")
                {
                    intersects = HasCenterlineHit(e, footprint, plenumMinZ, plenumMaxZ);
                    if (!intersects)
                    {
                        // fallback when centerline sample is unavailable
                        intersects = BBoxIntersectsExpanded(e, plenumMin, plenumMax);
                    }
                }
                else
                {
                    intersects = BBoxIntersectsExpanded(e, plenumMin, plenumMax);
                }

                if (!intersects) continue;

                var key = SelectionUtil.GetCategoryToken(e) ?? (e.Category?.Name ?? "None");
                byCategoryCounts[key] = byCategoryCounts.TryGetValue(key, out var c) ? c + 1 : 1;
                matches.Add(RevitBridge.Common.ElementIdCompat.GetValue(e.Id));
            }

            if (unknownCategories.Count > 0) warnings.Add($"Unknown categories ignored: {string.Join(", ", unknownCategories)}");

            var result = new
            {
                status = "Ok",
                roomId = RevitBridge.Common.ElementIdCompat.GetValue(spatial.Id),
                roomNumber = GetSpatialNumber(spatial),
                spatialKind = GetSpatialKind(spatial),
                intersectMode = mode,
                plenumTopLevel = level.Name,
                plenumTopLevelId = RevitBridge.Common.ElementIdCompat.GetValue(level.Id),
                filters = new
                {
                    categories = bicList.Select(x => x.ToString()).Distinct().ToList(),
                    systemClassification = systemFilter.Length > 0 ? systemFilter : null,
                    sizeEquals = sizeFilter.Length > 0 ? sizeFilter : null,
                    sizeEqualsFt = targetSizeFt,
                    verticalTolerance = tol
                },
                elementIds = matches.OrderBy(x => x).ToList(),
                byCategoryCounts,
                scanned,
                roomTopZ = roomTopZ.Value,
                plenumMinZ = plenumMinZ,
                plenumMaxZ = plenumMaxZ,
                usedBoundaryFootprint,
                debug = new
                {
                    roomSolidBbox = roomDebugBbox,
                    plenumSolidBbox = plenumDebugBbox
                },
                warnings
            };

            return Task.FromResult<object>(result);
        }

        private static bool BBoxIntersectsExpanded(Element e, XYZ plenumMin, XYZ plenumMax)
        {
            var bb = e?.get_BoundingBox(null);
            if (bb == null) return false;

            if (bb.Max.X < plenumMin.X - CoordTolerance) return false;
            if (bb.Min.X > plenumMax.X + CoordTolerance) return false;
            if (bb.Max.Y < plenumMin.Y - CoordTolerance) return false;
            if (bb.Min.Y > plenumMax.Y + CoordTolerance) return false;
            if (bb.Max.Z < plenumMin.Z - CoordTolerance) return false;
            if (bb.Min.Z > plenumMax.Z + CoordTolerance) return false;
            return true;
        }

        private static bool HasCenterlineHit(Element e, List<XYZ> footprintXY, double minZ, double maxZ)
        {
            var points = GetCenterlinePoints(e);
            if (points.Count == 0) return false;

            foreach (var p in points)
            {
                if (p.Z < minZ - CoordTolerance || p.Z > maxZ + CoordTolerance) continue;
                if (PointInPolygon2D(footprintXY, p.X, p.Y)) return true;
            }

            return false;
        }

        private static List<XYZ> GetCenterlinePoints(Element e)
        {
            var points = new List<XYZ>();
            try
            {
                if (e.Location is LocationCurve lc && lc.Curve != null)
                {
                    var curve = lc.Curve;
                    var steps = Math.Max(2, (int)Math.Ceiling(Math.Max(1.0, curve.Length / 3.0)));
                    for (int i = 0; i <= steps; i++)
                    {
                        var t = steps <= 0 ? 0.0 : (double)i / steps;
                        points.Add(curve.Evaluate(t, true));
                    }
                    return points;
                }
            }
            catch
            {
                // ignore
            }

            try
            {
                var bb = e.get_BoundingBox(null);
                if (bb != null)
                {
                    points.Add((bb.Min + bb.Max) * 0.5);
                }
            }
            catch
            {
                // ignore
            }

            return points;
        }

        private static bool MatchesSystemClassification(Element e, string required)
        {
            return MepSystemUtil.ElementMatchesSystemClassification(e, required);
        }

        private static bool MatchesSizeFilter(Document doc, Element e, double targetFt)
        {
            var probe = GetElementSizes(doc, e);
            if (probe.Diameters.Any(v => Math.Abs(v - targetFt) <= SizeTolerance)) return true;

            if (probe.Widths.Count > 0 && probe.Heights.Count > 0)
            {
                foreach (var w in probe.Widths)
                {
                    foreach (var h in probe.Heights)
                    {
                        if (Math.Abs(w - targetFt) <= SizeTolerance && Math.Abs(h - targetFt) <= SizeTolerance) return true;
                    }
                }
            }

            if (probe.Widths.Any(v => Math.Abs(v - targetFt) <= SizeTolerance)) return true;
            if (probe.Heights.Any(v => Math.Abs(v - targetFt) <= SizeTolerance)) return true;

            return false;
        }

        private sealed class SizeProbe
        {
            public HashSet<double> Diameters { get; } = new HashSet<double>();
            public HashSet<double> Widths { get; } = new HashSet<double>();
            public HashSet<double> Heights { get; } = new HashSet<double>();
        }

        private static SizeProbe GetElementSizes(Document doc, Element e)
        {
            var p = new SizeProbe();
            if (e == null) return p;

            try
            {
                foreach (var c in MepSystemUtil.GetConnectors(e))
                {
                    if (c == null) continue;
                    if (c.Shape == ConnectorProfileType.Round) p.Diameters.Add(2.0 * c.Radius);
                    else if (c.Shape == ConnectorProfileType.Rectangular)
                    {
                        p.Widths.Add(c.Width);
                        p.Heights.Add(c.Height);
                    }
                }
            }
            catch
            {
                // ignore
            }

            try
            {
                foreach (Parameter param in e.Parameters)
                {
                    if (param == null) continue;
                    var n = NormalizeName(param.Definition?.Name ?? "");
                    if (n.Length == 0) continue;

                    if (IsDiameterName(n) && TryGetParameterLength(doc, param, out var d)) p.Diameters.Add(d);
                    else if (IsRadiusName(n) && TryGetParameterLength(doc, param, out var r)) p.Diameters.Add(r * 2.0);
                    else if (IsWidthName(n) && TryGetParameterLength(doc, param, out var w)) p.Widths.Add(w);
                    else if (IsHeightName(n) && TryGetParameterLength(doc, param, out var h)) p.Heights.Add(h);
                    else if (n == "size")
                    {
                        if (TryParseDimensionPair(param.AsValueString() ?? param.AsString(), out var sw, out var sh))
                        {
                            p.Widths.Add(sw);
                            p.Heights.Add(sh);
                        }
                        else if (TryGetParameterLength(doc, param, out var x)) p.Diameters.Add(x);
                    }
                }
            }
            catch
            {
                // ignore
            }

            return p;
        }

        private static bool IsDiameterName(string n) =>
            n == "diameter" || n == "diameter1" || n == "diameter2" || n == "nominaldiameter" ||
            n == "ductdiameter" || n == "connectordiameter" || n == "ductsize";

        private static bool IsRadiusName(string n) =>
            n == "radius" || n == "radius1" || n == "radius2" || n == "ductradius" || n == "connectorradius";

        private static bool IsWidthName(string n) =>
            n == "width" || n == "width1" || n == "width2" || n == "ductwidth" || n == "connectorwidth";

        private static bool IsHeightName(string n) =>
            n == "height" || n == "height1" || n == "height2" || n == "ductheight" || n == "connectorheight";

        private static bool TryGetParameterLength(Document doc, Parameter param, out double feet)
        {
            feet = 0;
            if (param == null) return false;

            try
            {
                var raw = param.AsValueString();
                if (!string.IsNullOrWhiteSpace(raw) && TryParseLengthLoose(doc, raw, out feet, out _)) return true;

                if (param.StorageType == StorageType.Double)
                {
                    feet = param.AsDouble();
                    return true;
                }

                var asString = param.AsString();
                if (!string.IsNullOrWhiteSpace(asString) && TryParseLengthLoose(doc, asString, out feet, out _)) return true;
            }
            catch
            {
                // ignore
            }

            return false;
        }

        private static bool TryParseDimensionPair(string raw, out double w, out double h)
        {
            w = 0;
            h = 0;
            if (string.IsNullOrWhiteSpace(raw)) return false;

            var parts = Regex.Split(raw, @"x", RegexOptions.IgnoreCase);
            if (parts.Length < 2) return false;

            if (!TryParseLengthLoose(null, parts[0], out w, out _)) return false;
            if (!TryParseLengthLoose(null, parts[1], out h, out _)) return false;
            return true;
        }

        private static bool TryParseLengthLoose(Document? doc, string raw, out double valueInternal, out string error)
        {
            valueInternal = 0;
            error = "";
            var t = (raw ?? "").Trim();
            if (t.Length == 0)
            {
                error = "Empty length string.";
                return false;
            }

            try
            {
                if (doc != null)
                {
                    var units = doc.GetUnits();
                    if (UnitFormatUtils.TryParse(units, SpecTypeId.Length, t, out var parsed))
                    {
                        valueInternal = parsed;
                        return true;
                    }
                }

                if (double.TryParse(t, NumberStyles.Float, CultureInfo.InvariantCulture, out valueInternal) ||
                    double.TryParse(t, NumberStyles.Float, CultureInfo.CurrentCulture, out valueInternal))
                {
                    return true;
                }

                if (t.EndsWith("\"", StringComparison.OrdinalIgnoreCase) || t.EndsWith("in", StringComparison.OrdinalIgnoreCase))
                {
                    var num = t.EndsWith("\"", StringComparison.OrdinalIgnoreCase)
                        ? t.Substring(0, t.Length - 1)
                        : t.Substring(0, t.Length - 2);
                    if (double.TryParse(num, NumberStyles.Float, CultureInfo.InvariantCulture, out var inches) ||
                        double.TryParse(num, NumberStyles.Float, CultureInfo.CurrentCulture, out inches))
                    {
                        valueInternal = inches / 12.0;
                        return true;
                    }
                }

                if (t.EndsWith("'", StringComparison.OrdinalIgnoreCase) || t.EndsWith("ft", StringComparison.OrdinalIgnoreCase))
                {
                    var num = t.EndsWith("'", StringComparison.OrdinalIgnoreCase)
                        ? t.Substring(0, t.Length - 1)
                        : t.Substring(0, t.Length - 2);
                    if (double.TryParse(num, NumberStyles.Float, CultureInfo.InvariantCulture, out var ft) ||
                        double.TryParse(num, NumberStyles.Float, CultureInfo.CurrentCulture, out ft))
                    {
                        valueInternal = ft;
                        return true;
                    }
                }

                if (t.EndsWith("mm", StringComparison.OrdinalIgnoreCase) ||
                    t.EndsWith("cm", StringComparison.OrdinalIgnoreCase) ||
                    t.EndsWith("m", StringComparison.OrdinalIgnoreCase))
                {
                    var isMm = t.EndsWith("mm", StringComparison.OrdinalIgnoreCase);
                    var isCm = t.EndsWith("cm", StringComparison.OrdinalIgnoreCase);
                    var isM = !isMm && !isCm && t.EndsWith("m", StringComparison.OrdinalIgnoreCase);

                    var num = isMm || isCm
                        ? t.Substring(0, t.Length - 2)
                        : t.Substring(0, t.Length - 1);
                    if (double.TryParse(num, NumberStyles.Float, CultureInfo.InvariantCulture, out var mv) ||
                        double.TryParse(num, NumberStyles.Float, CultureInfo.CurrentCulture, out mv))
                    {
                        var meters = isMm ? (mv / 1000.0) : (isCm ? (mv / 100.0) : mv);
                        valueInternal = meters / 0.3048;
                        return true;
                    }
                }

                error = $"Invalid length string: \"{raw}\".";
                return false;
            }
            catch (Exception ex)
            {
                error = ex.Message;
                return false;
            }
        }

        private static (double minX, double maxX, double minY, double maxY) Bounds(List<XYZ> pts)
        {
            if (pts == null || pts.Count == 0) return (0, 0, 0, 0);
            var minX = pts.Min(p => p.X);
            var maxX = pts.Max(p => p.X);
            var minY = pts.Min(p => p.Y);
            var maxY = pts.Max(p => p.Y);
            return (minX, maxX, minY, maxY);
        }

        private static bool PointInPolygon2D(List<XYZ> poly, double x, double y)
        {
            if (poly == null || poly.Count < 3) return false;

            // boundary checks
            const double eps = 1e-9;
            for (int i = 0; i < poly.Count; i++)
            {
                var a = poly[i];
                var b = poly[(i + 1) % poly.Count];
                if (PointToSegmentDistance2D(x, y, a, b) <= eps) return true;
            }

            bool inside = false;
            for (int i = 0, j = poly.Count - 1; i < poly.Count; j = i++)
            {
                var xi = poly[i].X;
                var yi = poly[i].Y;
                var xj = poly[j].X;
                var yj = poly[j].Y;
                var intersects = ((yi > y) != (yj > y)) &&
                                 (x < (xj - xi) * (y - yi) / (yj - yi) + xi);
                if (intersects) inside = !inside;
            }

            return inside;
        }

        private static double PointToSegmentDistance2D(double x, double y, XYZ a, XYZ b)
        {
            var dx = b.X - a.X;
            var dy = b.Y - a.Y;
            var len2 = dx * dx + dy * dy;
            if (len2 <= 0.0) return (new XYZ(x, y, 0) - a).GetLength();

            var t = Math.Max(0.0, Math.Min(1.0, ((x - a.X) * dx + (y - a.Y) * dy) / len2));
            var px = a.X + t * dx;
            var py = a.Y + t * dy;
            var vx = x - px;
            var vy = y - py;
            return vx * vx + vy * vy;
        }

        private static List<XYZ> GetSpatialFootprint(SpatialElement spatial)
        {
            var options = new SpatialElementBoundaryOptions { SpatialElementBoundaryLocation = SpatialElementBoundaryLocation.Finish };

            try
            {
                var loops = spatial?.GetBoundarySegments(options);
                if (loops == null || loops.Count == 0) return new List<XYZ>();

                List<XYZ>? bestLoop = null;
                double bestArea = -1;

                foreach (var loop in loops)
                {
                    var pts = new List<XYZ>();
                    foreach (var seg in loop)
                    {
                        if (seg == null) continue;
                        try
                        {
                            var curve = seg.GetCurve();
                            foreach (var p in curve.Tessellate())
                            {
                                if (pts.Count == 0 || !pts[pts.Count - 1].IsAlmostEqualTo(p)) pts.Add(p);
                            }
                        }
                        catch
                        {
                            // skip
                        }
                    }

                    if (pts.Count < 3) continue;
                    if (pts[0].IsAlmostEqualTo(pts[pts.Count - 1])) pts.RemoveAt(pts.Count - 1);
                    if (pts.Count < 3) continue;

                    var area = Math.Abs(PolygonArea2D(pts));
                    if (area > bestArea)
                    {
                        bestArea = area;
                        bestLoop = pts;
                    }
                }

                return bestLoop ?? new List<XYZ>();
            }
            catch
            {
                return new List<XYZ>();
            }
        }

        private static double PolygonArea2D(List<XYZ> pts)
        {
            if (pts == null || pts.Count < 3) return 0;
            double area = 0;
            for (int i = 0; i < pts.Count; i++)
            {
                var j = (i + 1) % pts.Count;
                area += pts[i].X * pts[j].Y - pts[j].X * pts[i].Y;
            }
            return 0.5 * area;
        }

        private static SpatialElement? FindSpatialElementByNumber(Document doc, string roomOrSpaceNumber)
        {
            var q = (roomOrSpaceNumber ?? "").Trim();
            if (q.Length == 0 || doc == null) return null;
            var qNorm = NormalizeNumericRoomNumber(q);

            foreach (var room in new FilteredElementCollector(doc).OfCategory(BuiltInCategory.OST_Rooms).Cast<Room>())
            {
                var n = (room.Number ?? "").Trim();
                if (string.Equals(n, q, StringComparison.OrdinalIgnoreCase)) return room;
                if (NormalizeNumericRoomNumber(n).Equals(qNorm, StringComparison.OrdinalIgnoreCase)) return room;
            }

            foreach (var space in new FilteredElementCollector(doc).OfCategory(BuiltInCategory.OST_MEPSpaces).Cast<Space>())
            {
                var n = (space.Number ?? "").Trim();
                if (string.Equals(n, q, StringComparison.OrdinalIgnoreCase)) return space;
                if (NormalizeNumericRoomNumber(n).Equals(qNorm, StringComparison.OrdinalIgnoreCase)) return space;
            }

            return null;
        }

        private static bool TryGetSpatialBaseAndTopZ(SpatialElement spatial, out double? baseZ, out double? topZ)
        {
            baseZ = null;
            topZ = null;
            if (spatial == null) return false;

            try
            {
                if (spatial is Room room && room.Level != null)
                {
                    baseZ = room.Level.Elevation + room.BaseOffset;
                    if (room.UpperLimit != null) topZ = room.UpperLimit.Elevation + room.LimitOffset;
                    else topZ = baseZ + Math.Max(1.0, room.UnboundedHeight);
                    return true;
                }
            }
            catch
            {
                // ignore
            }

            try
            {
                var bb = spatial.get_BoundingBox(null);
                if (bb != null)
                {
                    baseZ = bb.Min.Z;
                    topZ = bb.Max.Z;
                    return true;
                }
            }
            catch
            {
                // ignore
            }

            return false;
        }

        private static Level? ResolveLevelByName(Document doc, string levelName)
        {
            var q = (levelName ?? "").Trim();
            if (q.Length == 0 || doc == null) return null;

            var allLevels = new FilteredElementCollector(doc).OfClass(typeof(Level)).Cast<Level>().ToList();
            var exact = allLevels.FirstOrDefault(x => string.Equals(x.Name, q, StringComparison.OrdinalIgnoreCase));
            if (exact != null) return exact;

            var contains = allLevels.FirstOrDefault(x => x.Name.IndexOf(q, StringComparison.OrdinalIgnoreCase) >= 0);
            if (contains != null) return contains;

            return null;
        }

        private static object ToPoint(XYZ p) => new { x = p.X, y = p.Y, z = p.Z };

        private static string NormalizeName(string value)
        {
            if (string.IsNullOrWhiteSpace(value)) return "";
            return new string(value.Where(char.IsLetterOrDigit).Select(char.ToLowerInvariant).ToArray());
        }

        private static string NormalizeNumericRoomNumber(string s)
        {
            if (s == null) return "";
            var t = s.Trim();
            if (t.Length == 0) return "";
            foreach (var c in t) { if (!char.IsDigit(c)) return t; }
            var stripped = t.TrimStart('0');
            return stripped.Length == 0 ? "0" : stripped;
        }

        private static string GetSpatialKind(SpatialElement spatial) =>
            spatial is Room ? "Room" : (spatial is Space ? "Space" : "SpatialElement");

        private static string GetSpatialNumber(SpatialElement spatial)
        {
            if (spatial is Room r) return r.Number;
            if (spatial is Space s) return s.Number;
            return "";
        }
    }
}
