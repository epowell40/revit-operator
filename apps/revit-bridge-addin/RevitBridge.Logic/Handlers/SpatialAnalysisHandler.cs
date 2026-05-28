using System;
using System.Collections.Generic;
using System.Linq;
using System.Text.Json;
using System.Threading.Tasks;
using Autodesk.Revit.DB;
using Autodesk.Revit.DB.Architecture;
using Autodesk.Revit.UI;
using RevitBridge.Common;

namespace RevitBridge.Logic.Handlers
{
    public class SpatialAnalysisHandler : IRequestHandler
    {
        private const double FeetPerInch = 1.0 / 12.0;

        public class Request
        {
            public List<string> levels { get; set; }
            public List<string> room_names { get; set; }
            public List<long> selection { get; set; }
            public RuleSet ruleset { get; set; }
        }

        public class RuleSet
        {
            public List<Rule> rules { get; set; }
        }

        public class Rule
        {
            public string id { get; set; }
            public string citation { get; set; }
            public string description { get; set; }
            public string category { get; set; } // OST_Rooms, OST_Doors, etc.
            public List<string> filter_name_contains { get; set; }
            public List<string> filter_room_name_contains { get; set; }
            public string check_type { get; set; }
            
            // Param values
            public double? min_diameter_in { get; set; }
            public double? min_sf { get; set; }
            public string param_name { get; set; }
            public double? min_val_ft { get; set; }
            public double? min_dist_in { get; set; }
            public double? max_dist_in { get; set; }
            public double? min_dim_ft { get; set; } // New property
            public double? clearance_depth_ft { get; set; }
            public double? clearance_width_ratio { get; set; }
            public string direction { get; set; } // "foot", "head", "sides"
        }

        public class ComplianceReport
        {
            public Summary summary { get; set; } = new Summary();
            public List<Violation> violations { get; set; } = new List<Violation>();
        }

        public class Summary
        {
            public int passed { get; set; }
            public int failed { get; set; }
            public int warnings { get; set; }
        }

        public class Violation
        {
            public long roomId { get; set; }
            public string roomName { get; set; }
            public string rule { get; set; }
            public string citation { get; set; }
            public string expected { get; set; }
            public string actual { get; set; }
            public LocationData location { get; set; }
            public string severity { get; set; }
        }

        public class LocationData { public double x { get; set; } public double y { get; set; } public double z { get; set; } }

        public Task<object> Handle(UIApplication app, string jsonData)
        {
            var req = JsonSerializer.Deserialize<Request>(jsonData);
            var doc = app.ActiveUIDocument.Document;
            var report = new ComplianceReport();

            // 1. Resolve Scope
            var targetElements = new List<Element>();
            
            // Simple scope resolution for V1: Get all elements of rule categories in target levels
            // Group rules by category
            var rulesByCategory = req.ruleset.rules.GroupBy(r => r.category);

            // Find 3D View for Raycasting
            View3D view3D = new FilteredElementCollector(doc).OfClass(typeof(View3D)).Cast<View3D>().FirstOrDefault(v => !v.IsTemplate && v.IsSectionBoxActive == false);
            // If no suitable 3D view, raycasting might fail. Create one?
            
            using (Transaction t = new Transaction(doc, "Spatial Analysis"))
            {
                t.Start();
                
                // Ensure we have a 3D view for intersector
                if (view3D == null)
                {
                    var type = new FilteredElementCollector(doc).OfClass(typeof(ViewFamilyType)).Cast<ViewFamilyType>().First(x => x.ViewFamily == ViewFamily.ThreeDimensional);
                    view3D = View3D.CreateIsometric(doc, type.Id);
                }

                foreach (var group in rulesByCategory)
                {
                    if (!Enum.TryParse(group.Key, out BuiltInCategory bic)) continue;

                    var collector = new FilteredElementCollector(doc).OfCategory(bic).WhereElementIsNotElementType();
                    
                    // Filter by Level
                    if (req.levels != null && req.levels.Any())
                    {
                        // This is slow, but robust
                        // Pre-fetch levels
                        var levelIds = new HashSet<ElementId>(
                            new FilteredElementCollector(doc).OfClass(typeof(Level))
                            .Cast<Level>()
                            .Where(l => req.levels.Contains(l.Name))
                            .Select(l => l.Id)
                        );
                        
                        // We check Element.LevelId
                        // For Rooms/Spaces it's robust. For families it works.
                        // Optimization: pass level filter to collector if single level.
                    }

                    var elements = collector.ToElements();

                    foreach (var elem in elements)
                    {
                        // Level Check
                        if (req.levels != null && req.levels.Any())
                        {
                            var lvl = doc.GetElement(elem.LevelId) as Level;
                            if (lvl == null || !req.levels.Contains(lvl.Name)) continue;
                        }

                        // Name Filter Check (Basic)
                        foreach (var rule in group)
                        {
                            if (req.room_names != null && req.room_names.Count > 0)
                            {
                                if (!PassesRoomNameFilter(doc, elem, req.room_names)) continue;
                            }

                            if (rule.filter_room_name_contains != null && rule.filter_room_name_contains.Count > 0)
                            {
                                if (!PassesRoomNameFilter(doc, elem, rule.filter_room_name_contains)) continue;
                            }

                            if (PassesElementNameFilter(elem, rule.filter_name_contains))
                            {
                                CheckRule(doc, elem, rule, report, view3D);
                            }
                        }
                    }
                }
                
                t.RollBack(); // No changes made, just analysis
            }

            return Task.FromResult<object>(report);
        }

        private bool PassesElementNameFilter(Element e, List<string> filters)
        {
            if (filters == null || filters.Count == 0) return true;
            string name = e.Name;
            // Also check Room Name if it's a room
            if (e is Room r) name = r.Name;
            // Also check Family Name
            var type = e.Document.GetElement(e.GetTypeId()) as ElementType;
            string familyName = type?.FamilyName ?? "";
            
            string full = $"{name} {familyName}";
            
            foreach (var f in filters)
            {
                if (MatchesFilter(full, f)) return true;
            }
            return false;
        }

        private bool PassesRoomNameFilter(Document doc, Element e, List<string> filters)
        {
            if (filters == null || filters.Count == 0) return true;

            List<Room> rooms = GetAssociatedRooms(doc, e);
            if (rooms.Count == 0) return false;

            foreach (var room in rooms)
            {
                string roomLabel = $"{room.Number} {room.Name}";
                foreach (var f in filters)
                {
                    if (MatchesFilter(roomLabel, f)) return true;
                }
            }

            return false;
        }

        private static bool MatchesFilter(string haystack, string needle)
        {
            if (string.IsNullOrWhiteSpace(needle)) return true;
            if (string.IsNullOrWhiteSpace(haystack)) return false;

            needle = needle.Trim();

            // Treat very short filters (e.g. "OR", "CT") as whole-word tokens to avoid accidental substring matches.
            if (needle.Length <= 2)
            {
                foreach (var token in Tokenize(haystack))
                {
                    if (string.Equals(token, needle, StringComparison.OrdinalIgnoreCase)) return true;
                }
                return false;
            }

            return haystack.IndexOf(needle, StringComparison.OrdinalIgnoreCase) >= 0;
        }

        private static IEnumerable<string> Tokenize(string s)
        {
            if (string.IsNullOrEmpty(s)) yield break;
            var current = new List<char>();

            foreach (var ch in s)
            {
                if (char.IsLetterOrDigit(ch))
                {
                    current.Add(ch);
                    continue;
                }

                if (current.Count > 0)
                {
                    yield return new string(current.ToArray());
                    current.Clear();
                }
            }

            if (current.Count > 0) yield return new string(current.ToArray());
        }

        private List<Room> GetAssociatedRooms(Document doc, Element e)
        {
            var rooms = new List<Room>();
            if (e is Room r) rooms.Add(r);

            if (e is FamilyInstance fi)
            {
                if (fi.Room != null) rooms.Add(fi.Room);
                if (fi.FromRoom != null) rooms.Add(fi.FromRoom);
                if (fi.ToRoom != null) rooms.Add(fi.ToRoom);
            }

            return rooms
                .Where(x => x != null)
                .GroupBy(x => x.Id)
                .Select(g => g.First())
                .ToList();
        }

        private void CheckRule(Document doc, Element e, Rule rule, ComplianceReport report, View3D view3D)
        {
            bool pass = true;
            string actual = "";
            string expected = "";
            XYZ violationLocation = null;

            try
            {
                switch (rule.check_type)
                {
                    case "min_area":
                        if (e is Room room)
                        {
                            double area = room.Area; // SqFt
                            if (area < rule.min_sf)
                            {
                                pass = false;
                                actual = $"{area:F1} SF";
                                expected = $">= {rule.min_sf} SF";
                            }
                            else
                            {
                                actual = $"{area:F1} SF";
                                expected = $">= {rule.min_sf} SF";
                            }
                        }
                        break;

                    case "min_dimension":
                        if (e is Room rDim)
                        {
                            var dimResult = GetRoomMinDimension(rDim);
                            actual = $"{dimResult.MinDimFt:F2} ft";
                            expected = $">= {rule.min_dim_ft} ft";

                            if (dimResult.MinDimFt < (rule.min_dim_ft ?? 0))
                            {
                                pass = false;
                                violationLocation = dimResult.ReferencePoint;
                            }
                        }
                        break;

                    case "param_value":
                        var p = e.LookupParameter(rule.param_name);
                        if (p != null && p.HasValue)
                        {
                            double val = p.AsDouble(); // Assuming length/number
                            if (val < rule.min_val_ft)
                            {
                                pass = false;
                                actual = $"{val:F2} ft";
                                expected = $">= {rule.min_val_ft} ft";
                            }
                            else
                            {
                                actual = $"{val:F2} ft";
                                expected = $">= {rule.min_val_ft} ft";
                            }
                        }
                        break;

                    case "inscribed_circle":
                        if (e is Room r2)
                        {
                            XYZ center;
                            double dia = GetMaxInscribedCircleDiameter(doc, r2, out center); // In Feet
                            double minDiaFt = (rule.min_diameter_in ?? 0) * FeetPerInch;

                            actual = $"Max Diameter {(dia * 12.0):F1} in";
                            expected = $">= {rule.min_diameter_in} in";
                            
                            if (dia < minDiaFt)
                            {
                                pass = false;
                                violationLocation = center;
                            }
                            else
                            {
                                violationLocation = center;
                            }
                        }
                        break;

                    case "distance_to_wall":
                        // Toilet Centerline
                        if (e is FamilyInstance fi)
                        {
                            double dist = GetDistanceToSideWall(doc, fi, view3D); // Feet
                            if (dist > 0)
                            {
                                double distIn = dist * 12.0;
                                actual = $"{distIn:F1} in";
                                expected = $"{rule.min_dist_in}-{rule.max_dist_in} in";
                                if (distIn < rule.min_dist_in || distIn > rule.max_dist_in)
                                {
                                    pass = false;
                                }
                            }
                            else
                            {
                                pass = false;
                                actual = "Unable to determine side wall distance";
                                expected = $"{rule.min_dist_in}-{rule.max_dist_in} in";
                            }
                        }
                        break;
                    
                    case "clearance_box":
                        // Bed clearances
                        // This implies checking if the clearance box intersects walls/columns
                        // Requires creating a Transient Solid and running collision
                        // Complex: Simplified for now - assume pass or implement basic bounding box overlap?
                        // Implementing Solid Intersection is best.
                        var clearance = CheckClearance(doc, e, rule);
                        actual = clearance.Actual;
                        expected = clearance.Expected;
                        violationLocation = clearance.Location;
                        if (!clearance.Clear)
                        {
                            pass = false;
                        }
                        break;
                    default:
                        pass = false;
                        actual = $"Unknown check_type: {rule.check_type}";
                        expected = "Known check_type";
                        break;
                }
            }
            catch (Exception ex)
            {
                pass = false;
                actual = $"Error: {ex.Message}";
            }

            if (pass)
            {
                report.summary.passed++;
            }
            else
            {
                report.summary.failed++;
                
                string rName = e.Name;
                long rId = RevitBridge.Common.ElementIdCompat.GetValue(e.Id);
                
                // If element is not a room, try to find the room it's in for context
                if (!(e is Room))
                {
                    if (e is FamilyInstance fi2 && fi2.Room != null) 
                    {
                        rName = $"{fi2.Room.Number} {fi2.Room.Name} ({e.Name})";
                        rId = RevitBridge.Common.ElementIdCompat.GetValue(fi2.Room.Id);
                    }
                }

                XYZ loc = null;
                if (e.Location is LocationPoint lp) loc = lp.Point;
                else if (e is Room rr) loc = (rr.Location as LocationPoint)?.Point;
                if (violationLocation != null) loc = violationLocation;

                report.violations.Add(new Violation
                {
                    roomId = rId,
                    roomName = rName,
                    rule = rule.id,
                    citation = rule.citation,
                    expected = expected,
                    actual = actual,
                    severity = "Error",
                    location = loc != null ? new LocationData { x = loc.X, y = loc.Y, z = loc.Z } : null
                });
            }
        }

        // --- Geometric Helpers ---

        private class RoomMinDimensionResult
        {
            public double MinDimFt { get; set; }
            public XYZ ReferencePoint { get; set; }
        }

        private RoomMinDimensionResult GetRoomMinDimension(Room room)
        {
            var boundary = GetRoomOuterBoundaryPolyline(room);
            if (boundary == null || boundary.Count < 3)
            {
                var bbox = room.get_BoundingBox(null);
                if (bbox != null)
                {
                    double w = bbox.Max.X - bbox.Min.X;
                    double d = bbox.Max.Y - bbox.Min.Y;
                    return new RoomMinDimensionResult
                    {
                        MinDimFt = Math.Min(w, d),
                        ReferencePoint = (room.Location as LocationPoint)?.Point
                    };
                }

                return new RoomMinDimensionResult
                {
                    MinDimFt = 0,
                    ReferencePoint = (room.Location as LocationPoint)?.Point
                };
            }

            XYZ axis1, axis2;
            if (!TryGetDominantOrthogonalAxes(boundary, out axis1, out axis2))
            {
                axis1 = XYZ.BasisX;
                axis2 = XYZ.BasisY;
            }

            GetProjectedExtents(boundary, axis1, axis2, out double extent1, out double extent2);

            return new RoomMinDimensionResult
            {
                MinDimFt = Math.Min(extent1, extent2),
                ReferencePoint = (room.Location as LocationPoint)?.Point
            };
        }

        private double GetMaxInscribedCircleDiameter(Document doc, Room room, out XYZ bestCenter)
        {
            bestCenter = (room.Location as LocationPoint)?.Point;

            var boundary = GetRoomOuterBoundaryPolyline(room);
            if (boundary == null || boundary.Count < 3) return 0;

            var segments = BuildPolylineSegments(boundary);
            if (segments.Count == 0) return 0;

            var bbox = room.get_BoundingBox(null);
            double z = GetRoomTestZ(room, bbox);

            GetBounds2D(boundary, out double minX, out double maxX, out double minY, out double maxY);
            if (minX >= maxX || minY >= maxY) return 0;

            double bestRadius = 0;
            XYZ best = null;

            double step = 1.0; // feet
            for (int refinement = 0; refinement < 5; refinement++)
            {
                for (double x = minX; x <= maxX; x += step)
                {
                    for (double y = minY; y <= maxY; y += step)
                    {
                        var p = new XYZ(x, y, z);
                        if (!room.IsPointInRoom(p)) continue;

                        double dist = DistanceToBoundary2D(p, segments);
                        if (dist > bestRadius)
                        {
                            bestRadius = dist;
                            best = p;
                        }
                    }
                }

                if (best == null) break;

                // Refine search around best point
                minX = best.X - step;
                maxX = best.X + step;
                minY = best.Y - step;
                maxY = best.Y + step;
                step *= 0.5;
            }

            if (best != null) bestCenter = best;
            return bestRadius * 2.0;
        }

        private static double GetRoomTestZ(Room room, BoundingBoxXYZ bbox)
        {
            if (bbox != null) return (bbox.Min.Z + bbox.Max.Z) * 0.5;

            var loc = (room.Location as LocationPoint)?.Point;
            if (loc != null) return loc.Z;

            return 0.0;
        }

        private static void GetBounds2D(List<XYZ> points, out double minX, out double maxX, out double minY, out double maxY)
        {
            minX = double.MaxValue;
            maxX = double.MinValue;
            minY = double.MaxValue;
            maxY = double.MinValue;

            foreach (var p in points)
            {
                minX = Math.Min(minX, p.X);
                maxX = Math.Max(maxX, p.X);
                minY = Math.Min(minY, p.Y);
                maxY = Math.Max(maxY, p.Y);
            }
        }

        private static void GetProjectedExtents(List<XYZ> points, XYZ axis1, XYZ axis2, out double extent1, out double extent2)
        {
            double min1 = double.MaxValue, max1 = double.MinValue;
            double min2 = double.MaxValue, max2 = double.MinValue;

            foreach (var p in points)
            {
                double s1 = p.X * axis1.X + p.Y * axis1.Y;
                double s2 = p.X * axis2.X + p.Y * axis2.Y;

                min1 = Math.Min(min1, s1);
                max1 = Math.Max(max1, s1);
                min2 = Math.Min(min2, s2);
                max2 = Math.Max(max2, s2);
            }

            extent1 = Math.Max(0, max1 - min1);
            extent2 = Math.Max(0, max2 - min2);
        }

        private static bool TryGetDominantOrthogonalAxes(List<XYZ> boundary, out XYZ axis1, out XYZ axis2)
        {
            axis1 = null;
            axis2 = null;

            var segments = BuildPolylineSegments(boundary);
            if (segments.Count == 0) return false;

            const int bins = 36; // 5-degree bins across 180 degrees
            var weights = new double[bins];

            foreach (var s in segments)
            {
                var v = s.B - s.A;
                v = new XYZ(v.X, v.Y, 0);
                double len = v.GetLength();
                if (len < 1e-6) continue;
                var d = v / len;

                double angle = Math.Atan2(d.Y, d.X);
                if (angle < 0) angle += Math.PI;

                int bin = (int)Math.Round(angle / Math.PI * (bins - 1));
                bin = Math.Max(0, Math.Min(bins - 1, bin));
                weights[bin] += len;
            }

            int maxBin = 0;
            double maxWeight = weights[0];
            for (int i = 1; i < bins; i++)
            {
                if (weights[i] > maxWeight)
                {
                    maxWeight = weights[i];
                    maxBin = i;
                }
            }

            if (maxWeight <= 1e-6) return false;

            double theta = (double)maxBin / (bins - 1) * Math.PI;
            axis1 = new XYZ(Math.Cos(theta), Math.Sin(theta), 0).Normalize();
            axis2 = new XYZ(-axis1.Y, axis1.X, 0).Normalize();
            return true;
        }

        private static List<(XYZ A, XYZ B)> BuildPolylineSegments(List<XYZ> polyline)
        {
            if (polyline == null || polyline.Count < 2) return new List<(XYZ, XYZ)>();

            var closed = new List<XYZ>(polyline);
            if (!polyline[0].IsAlmostEqualTo(polyline[polyline.Count - 1]))
            {
                closed.Add(polyline[0]);
            }

            var segments = new List<(XYZ, XYZ)>();
            for (int i = 0; i < closed.Count - 1; i++)
            {
                var a = closed[i];
                var b = closed[i + 1];
                if (a.DistanceTo(b) < 1e-6) continue;
                segments.Add((a, b));
            }

            return segments;
        }

        private static double DistanceToBoundary2D(XYZ p, List<(XYZ A, XYZ B)> segments)
        {
            double min = double.MaxValue;
            foreach (var s in segments)
            {
                double d = DistancePointToSegment2D(p, s.A, s.B);
                if (d < min) min = d;
            }

            return min == double.MaxValue ? 0 : min;
        }

        private static double DistancePointToSegment2D(XYZ p, XYZ a, XYZ b)
        {
            double px = p.X, py = p.Y;
            double ax = a.X, ay = a.Y;
            double bx = b.X, by = b.Y;

            double abx = bx - ax;
            double aby = by - ay;
            double apx = px - ax;
            double apy = py - ay;

            double ab2 = abx * abx + aby * aby;
            if (ab2 < 1e-12) return Math.Sqrt(apx * apx + apy * apy);

            double t = (apx * abx + apy * aby) / ab2;
            t = Math.Max(0, Math.Min(1, t));

            double cx = ax + t * abx;
            double cy = ay + t * aby;

            double dx = px - cx;
            double dy = py - cy;
            return Math.Sqrt(dx * dx + dy * dy);
        }

        private List<XYZ> GetRoomOuterBoundaryPolyline(Room room)
        {
            var opts = new SpatialElementBoundaryOptions();
            var loops = room.GetBoundarySegments(opts);
            if (loops == null || loops.Count == 0) return null;

            List<XYZ> best = null;
            double bestArea = 0;

            foreach (var loop in loops)
            {
                var pts = new List<XYZ>();
                foreach (var seg in loop)
                {
                    var curve = seg.GetCurve();
                    var tess = curve.Tessellate();
                    if (tess == null || tess.Count == 0) continue;

                    if (pts.Count > 0 && pts[pts.Count - 1].IsAlmostEqualTo(tess[0]))
                    {
                        pts.AddRange(tess.Skip(1));
                    }
                    else
                    {
                        pts.AddRange(tess);
                    }
                }

                if (pts.Count < 3) continue;

                double area = Math.Abs(PolygonArea2D(pts));
                if (area > bestArea)
                {
                    bestArea = area;
                    best = pts;
                }
            }

            return best;
        }

        private static double PolygonArea2D(List<XYZ> pts)
        {
            if (pts == null || pts.Count < 3) return 0;
            double sum = 0;

            for (int i = 0; i < pts.Count; i++)
            {
                int j = (i + 1) % pts.Count;
                sum += pts[i].X * pts[j].Y - pts[j].X * pts[i].Y;
            }

            return 0.5 * sum;
        }

        private double GetDistanceToSideWall(Document doc, FamilyInstance fi, View3D view3D)
        {
            // Raycast left and right of facing orientation
            if (fi.Location is LocationPoint lp)
            {
                XYZ origin = lp.Point + new XYZ(0,0,1); // Lift 1ft to hit wall not floor
                XYZ forward = fi.FacingOrientation;
                XYZ up = XYZ.BasisZ;
                XYZ right = forward.CrossProduct(up);
                XYZ left = -right;

                ReferenceIntersector intersector = new ReferenceIntersector(
                    new ElementClassFilter(typeof(Wall)), 
                    FindReferenceTarget.Element, 
                    view3D);
                
                var resRight = intersector.FindNearest(origin, right);
                var resLeft = intersector.FindNearest(origin, left);

                double distRight = resRight != null ? resRight.Proximity : double.MaxValue;
                double distLeft = resLeft != null ? resLeft.Proximity : double.MaxValue;

                // Return the smaller distance (nearest side wall)
                double min = Math.Min(distRight, distLeft);
                return min == double.MaxValue ? -1 : min;
            }
            return -1;
        }

        private class ClearanceCheckResult
        {
            public bool Clear { get; set; }
            public string Expected { get; set; }
            public string Actual { get; set; }
            public XYZ Location { get; set; }
        }

        private ClearanceCheckResult CheckClearance(Document doc, Element e, Rule rule)
        {
            var result = new ClearanceCheckResult
            {
                Clear = true,
                Expected = "Clear",
                Actual = "Clear",
                Location = (e.Location as LocationPoint)?.Point
            };

            if (!(e is FamilyInstance fi))
            {
                result.Clear = false;
                result.Expected = "FamilyInstance for clearance check";
                result.Actual = $"Unsupported element type: {e.GetType().Name}";
                return result;
            }

            double depth = rule.clearance_depth_ft ?? 0;
            if (depth <= 0)
            {
                result.Clear = false;
                result.Expected = "clearance_depth_ft > 0";
                result.Actual = "Missing clearance depth";
                return result;
            }

            if (!TryGetInstancePlacement(fi, out XYZ center, out XYZ hand, out XYZ facing, out double width, out double length, out double baseZ, out double instanceHeight))
            {
                result.Clear = false;
                result.Expected = "Valid instance placement + bbox";
                result.Actual = "Unable to compute clearance geometry";
                return result;
            }

            double widthRatio = rule.clearance_width_ratio ?? 1.0;
            double extrudeHeight = Math.Max(7.0, instanceHeight);

            var clearanceSolids = new List<Solid>();

            string direction = (rule.direction ?? "").Trim().ToLowerInvariant();
            if (direction == "foot" || direction == "head")
            {
                XYZ dir = direction == "head" ? -facing : facing;
                double clearanceWidth = width * widthRatio;
                XYZ edge = center + dir * (length * 0.5);
                XYZ rectCenter = new XYZ(edge.X, edge.Y, baseZ) + dir * (depth * 0.5);
                result.Location = rectCenter;
                clearanceSolids.Add(CreateExtrudedRectangleSolid(rectCenter, hand, dir, clearanceWidth * 0.5, depth * 0.5, extrudeHeight));
                result.Expected = $"Clear (depth {depth:F2} ft {direction}, width {clearanceWidth:F2} ft)";
            }
            else if (direction == "sides")
            {
                double clearanceLength = length * widthRatio;
                double halfLength = clearanceLength * 0.5;

                XYZ leftDir = -hand;
                XYZ rightDir = hand;

                XYZ leftEdge = center + leftDir * (width * 0.5);
                XYZ rightEdge = center + rightDir * (width * 0.5);

                XYZ leftCenter = new XYZ(leftEdge.X, leftEdge.Y, baseZ) + leftDir * (depth * 0.5);
                XYZ rightCenter = new XYZ(rightEdge.X, rightEdge.Y, baseZ) + rightDir * (depth * 0.5);

                result.Location = new XYZ(center.X, center.Y, baseZ);
                clearanceSolids.Add(CreateExtrudedRectangleSolid(leftCenter, leftDir, facing, depth * 0.5, halfLength, extrudeHeight));
                clearanceSolids.Add(CreateExtrudedRectangleSolid(rightCenter, rightDir, facing, depth * 0.5, halfLength, extrudeHeight));
                result.Expected = $"Clear (depth {depth:F2} ft both sides, length {clearanceLength:F2} ft)";
            }
            else
            {
                result.Clear = false;
                result.Expected = "direction: foot|head|sides";
                result.Actual = $"Unsupported direction: {rule.direction}";
                return result;
            }

            var obstructionCategories = new List<BuiltInCategory>
            {
                BuiltInCategory.OST_Walls,
                BuiltInCategory.OST_Columns,
                BuiltInCategory.OST_StructuralColumns,
                BuiltInCategory.OST_Casework,
                BuiltInCategory.OST_PlumbingFixtures,
                BuiltInCategory.OST_Furniture,
                BuiltInCategory.OST_SpecialityEquipment,
                BuiltInCategory.OST_GenericModel
            };

            var catIds = obstructionCategories.Select(x => RevitBridge.Common.ElementIdCompat.Create((long)x)).ToList();
            var catFilter = new ElementMulticategoryFilter(catIds);

            var allObstructions = new List<Element>();
            foreach (var solid in clearanceSolids)
            {
                var intersects = new ElementIntersectsSolidFilter(solid);
                var hits = new FilteredElementCollector(doc)
                    .WhereElementIsNotElementType()
                    .WherePasses(catFilter)
                    .WherePasses(intersects)
                    .ToElements()
                    .Where(x => x.Id != e.Id)
                    .ToList();

                allObstructions.AddRange(hits);
            }

            allObstructions = allObstructions
                .GroupBy(x => x.Id)
                .Select(g => g.First())
                .ToList();

            if (allObstructions.Count > 0)
            {
                result.Clear = false;
                var first = allObstructions.First();
                result.Actual = $"Obstructed by {first.Category?.Name ?? "Element"}: {first.Name} (Id {RevitBridge.Common.ElementIdCompat.GetValue(first.Id)})";

                var obstructionLoc = (first.Location as LocationPoint)?.Point;
                if (obstructionLoc == null)
                {
                    var bb = first.get_BoundingBox(null);
                    if (bb != null) obstructionLoc = (bb.Min + bb.Max) * 0.5;
                }

                if (obstructionLoc != null) result.Location = obstructionLoc;
            }

            return result;
        }

        private static bool TryGetInstancePlacement(
            FamilyInstance fi,
            out XYZ center,
            out XYZ hand,
            out XYZ facing,
            out double width,
            out double length,
            out double baseZ,
            out double height)
        {
            center = null;
            hand = null;
            facing = null;
            width = 0;
            length = 0;
            baseZ = 0;
            height = 0;

            var bbox = fi.get_BoundingBox(null);
            if (bbox == null) return false;

            var locationPoint = fi.Location as LocationPoint;
            center = locationPoint != null ? locationPoint.Point : (bbox.Min + bbox.Max) * 0.5;

            hand = Normalize2D(fi.HandOrientation);
            facing = Normalize2D(fi.FacingOrientation);
            if (hand.GetLength() < 1e-9) hand = XYZ.BasisX;
            if (facing.GetLength() < 1e-9) facing = XYZ.BasisY;

            // Ensure orthonormal basis in XY
            if (Math.Abs(hand.DotProduct(facing)) > 0.01)
            {
                facing = new XYZ(-hand.Y, hand.X, 0).Normalize();
            }

            // Project AABB corners to oriented axes (conservative extents)
            var corners = GetBoundingBoxCorners(bbox);
            double minHand = double.MaxValue, maxHand = double.MinValue;
            double minFacing = double.MaxValue, maxFacing = double.MinValue;

            foreach (var c in corners)
            {
                var v = c - center;
                double h = v.DotProduct(hand);
                double f = v.DotProduct(facing);
                minHand = Math.Min(minHand, h);
                maxHand = Math.Max(maxHand, h);
                minFacing = Math.Min(minFacing, f);
                maxFacing = Math.Max(maxFacing, f);
            }

            width = Math.Max(0.1, maxHand - minHand);
            length = Math.Max(0.1, maxFacing - minFacing);

            baseZ = bbox.Min.Z;
            height = bbox.Max.Z - bbox.Min.Z;

            return true;
        }

        private static XYZ Normalize2D(XYZ v)
        {
            if (v == null) return XYZ.Zero;
            var u = new XYZ(v.X, v.Y, 0);
            double len = u.GetLength();
            if (len < 1e-9) return XYZ.Zero;
            return u / len;
        }

        private static List<XYZ> GetBoundingBoxCorners(BoundingBoxXYZ bbox)
        {
            var min = bbox.Min;
            var max = bbox.Max;
            return new List<XYZ>
            {
                new XYZ(min.X, min.Y, min.Z),
                new XYZ(max.X, min.Y, min.Z),
                new XYZ(max.X, max.Y, min.Z),
                new XYZ(min.X, max.Y, min.Z),
                new XYZ(min.X, min.Y, max.Z),
                new XYZ(max.X, min.Y, max.Z),
                new XYZ(max.X, max.Y, max.Z),
                new XYZ(min.X, max.Y, max.Z)
            };
        }

        private static Solid CreateExtrudedRectangleSolid(XYZ center, XYZ axisX, XYZ axisY, double halfX, double halfY, double height)
        {
            axisX = Normalize2D(axisX);
            axisY = Normalize2D(axisY);

            XYZ c = new XYZ(center.X, center.Y, center.Z);

            XYZ p1 = c + axisX * halfX + axisY * halfY;
            XYZ p2 = c - axisX * halfX + axisY * halfY;
            XYZ p3 = c - axisX * halfX - axisY * halfY;
            XYZ p4 = c + axisX * halfX - axisY * halfY;

            var loop = new CurveLoop();
            loop.Append(Line.CreateBound(p1, p2));
            loop.Append(Line.CreateBound(p2, p3));
            loop.Append(Line.CreateBound(p3, p4));
            loop.Append(Line.CreateBound(p4, p1));

            return GeometryCreationUtilities.CreateExtrusionGeometry(new List<CurveLoop> { loop }, XYZ.BasisZ, height);
        }
    }
}

