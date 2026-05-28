using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text.Json;
using System.Threading.Tasks;
using Autodesk.Revit.DB;
using Autodesk.Revit.DB.Architecture;
using Autodesk.Revit.UI;
using RevitBridge.FireAlarm;

namespace RevitBridge.Handlers
{
    public class FireAlarmLayoutHandler : IRequestHandler
    {
        public class Request
        {
            public string runConfigPath { get; set; }
            public string deviceMappingsPath { get; set; }
            public string levelName { get; set; }
            public long? viewId { get; set; }
            public string runId { get; set; }
            public bool dryRun { get; set; }
            public bool createVisualizer { get; set; } = true;
        }

        private const string DeviceKeyStrobe = "STROBE_CEILING_30CD";
        private const string DeviceKeyPlaceholder = "PLACEHOLDER";

        public Task<object> Handle(UIApplication app, string jsonData)
        {
            var doc = app.ActiveUIDocument.Document;
            var opts = new JsonSerializerOptions { PropertyNameCaseInsensitive = true, ReadCommentHandling = JsonCommentHandling.Skip, AllowTrailingCommas = true };
            var req = JsonSerializer.Deserialize<Request>(jsonData ?? "{}", opts) ?? new Request();

            if (string.IsNullOrWhiteSpace(req.runId)) req.runId = Guid.NewGuid().ToString();

            var report = new FireAlarmLayoutReport
            {
                runId = req.runId,
                levelName = req.levelName,
                viewId = req.viewId ?? RevitBridge.Common.ElementIdCompat.GetValue(doc.ActiveView?.Id),
                dryRun = req.dryRun
            };

            var configPath = ResolveExistingPath(req.runConfigPath);
            if (string.IsNullOrWhiteSpace(configPath))
            {
                report.errors.Add("runConfigPath not found.");
                return Task.FromResult<object>(report);
            }

            FireAlarmRunConfig config;
            try
            {
                config = LoadJsonFile<FireAlarmRunConfig>(configPath, opts);
            }
            catch (Exception ex)
            {
                report.errors.Add($"Failed to parse run config: {ex.Message}");
                return Task.FromResult<object>(report);
            }

            var configDir = Path.GetDirectoryName(configPath) ?? "";
            var mappingsPath = ResolveMappingsPath(req.deviceMappingsPath, config.deviceMappingsPath, configDir);
            Dictionary<string, DeviceTypeMapping> mappings = new Dictionary<string, DeviceTypeMapping>(StringComparer.OrdinalIgnoreCase);
            if (!string.IsNullOrWhiteSpace(mappingsPath) && File.Exists(mappingsPath))
            {
                try
                {
                    mappings = LoadJsonFile<Dictionary<string, DeviceTypeMapping>>(mappingsPath, opts) ??
                               new Dictionary<string, DeviceTypeMapping>(StringComparer.OrdinalIgnoreCase);
                }
                catch (Exception ex)
                {
                    report.warnings.Add($"Failed to parse device mappings: {ex.Message}");
                }
            }
            else
            {
                report.warnings.Add("Device mappings file not provided or not found; placement will likely fail unless symbols exist via defaults.");
            }

            var view = ResolveView(doc, req.viewId);
            var level = ResolveLevel(doc, req.levelName, view, report);
            if (level == null)
            {
                report.errors.Add("Could not resolve target level.");
                return Task.FromResult<object>(report);
            }

            var rooms = new FilteredElementCollector(doc)
                .OfCategory(BuiltInCategory.OST_Rooms)
                .OfClass(typeof(SpatialElement))
                .Cast<SpatialElement>()
                .OfType<Room>()
                .Where(r => r.Area > 0 && r.Level != null && r.Level.Id == level.Id)
                .ToList();

            var wantsRoomStrobes = (config.devices ?? new List<string>()).Any(d => string.Equals(d, "STROBES_ROOMS", StringComparison.OrdinalIgnoreCase));
            var wantsCorridorStrobes = (config.devices ?? new List<string>()).Any(d => string.Equals(d, "STROBES_CORRIDORS", StringComparison.OrdinalIgnoreCase));

            var placementRequests = new List<(Room room, XYZ point, string deviceKey, string deviceKind)>();

            foreach (var room in rooms)
            {
                var classRes = RoomClassifier.Classify(room.Name, room.Area, config);
                var notify = NotificationRequirement.Decide(classRes.roomClass, room.Area, config);

                report.assumptions.Add(new FireAlarmAssumption
                {
                    roomId = RevitBridge.Common.ElementIdCompat.GetValue(room.Id),
                    roomNumber = room.Number,
                    roomName = room.Name,
                    areaFt2 = room.Area,
                    levelName = room.Level?.Name,
                    inferredClass = classRes.roomClass.ToString(),
                    classReasonCode = classRes.reasonCode,
                    notifyDecision = notify.decision.ToString(),
                    notifyReasonCode = notify.reasonCode
                });

                if (notify.decision != NotifyDecision.REQUIRE) continue;

                if (classRes.roomClass == RoomClass.CORRIDOR && wantsCorridorStrobes)
                {
                    foreach (var p in ComputeCorridorPoints(room, config, report))
                    {
                        placementRequests.Add((room, p, DeviceKeyStrobe, "STROBE"));
                    }
                }
                else if (classRes.roomClass != RoomClass.CORRIDOR && wantsRoomStrobes)
                {
                    var p = GetRoomPlacementPoint(room, view);
                    placementRequests.Add((room, p, DeviceKeyStrobe, "STROBE"));
                }
            }

            if (!req.dryRun && placementRequests.Any())
            {
                using (var t = new Transaction(doc, "Fire Alarm Layout (MVP)"))
                {
                    t.Start();
                    try
                    {
                        var symbolCache = new Dictionary<string, FamilySymbol>(StringComparer.OrdinalIgnoreCase);

                        foreach (var pr in placementRequests)
                        {
                            var mapping = ResolveMapping(mappings, pr.deviceKey);
                            var resolved = ResolveSymbol(doc, mapping, symbolCache, report);
                            if (resolved.symbol == null)
                            {
                                var placeholderMapping = ResolveMapping(mappings, DeviceKeyPlaceholder);
                                resolved = ResolveSymbol(doc, placeholderMapping, symbolCache, report);
                            }

                            if (resolved.symbol == null)
                            {
                                report.warnings.Add($"Skipping placement: no symbol found for deviceKey={pr.deviceKey} and no PLACEHOLDER mapping.");
                                continue;
                            }

                            if (!resolved.symbol.IsActive) resolved.symbol.Activate();

                            FamilyInstance fi = null;
                            try
                            {
                                fi = doc.Create.NewFamilyInstance(pr.point, resolved.symbol, level, Autodesk.Revit.DB.Structure.StructuralType.NonStructural);
                            }
                            catch
                            {
                                fi = doc.Create.NewFamilyInstance(pr.point, resolved.symbol, Autodesk.Revit.DB.Structure.StructuralType.NonStructural);
                            }

                            if (fi == null) continue;

                            TagElement(fi, req.runId, module: "FireAlarm", layer: null, kind: pr.deviceKind, roomId: RevitBridge.Common.ElementIdCompat.GetValue(pr.room.Id));

                            report.placed.Add(new LayoutPlacedInstance
                            {
                                elementId = RevitBridge.Common.ElementIdCompat.GetValue(fi.Id),
                                deviceKind = pr.deviceKind,
                                family = fi.Symbol?.FamilyName,
                                type = fi.Symbol?.Name,
                                x = pr.point.X,
                                y = pr.point.Y,
                                z = pr.point.Z,
                                roomId = RevitBridge.Common.ElementIdCompat.GetValue(pr.room.Id)
                            });
                        }

                        t.Commit();
                    }
                    catch (Exception ex)
                    {
                        report.errors.Add($"Placement failed: {ex.Message}");
                        t.RollBack();
                    }
                }
            }

            bool wantsVisualizer = req.createVisualizer && (config.visualizer?.enabled ?? false);
            if (wantsVisualizer)
            {
                if (view == null)
                {
                    report.warnings.Add("Visualizer requested but view could not be resolved; skipping visualizer.");
                }
                else if (!CanCreateDetailInView(view))
                {
                    report.warnings.Add($"Visualizer requested but view type {view.ViewType} does not support detail items; skipping visualizer.");
                }
                else
                {
                    var devicePoints = report.placed.Select(p => new XYZ(p.x, p.y, p.z)).ToList();
                    if (!devicePoints.Any())
                    {
                        report.warnings.Add("Visualizer requested but no devices were placed; skipping uncovered sampling.");
                    }
                    else if (!req.dryRun)
                    {
                        var uncovered = ComputeUncoveredPoints(rooms, devicePoints, config);
                        if (uncovered.Any())
                        {
                            using (var t2 = new Transaction(doc, "Fire Alarm Visualizer (MVP)"))
                            {
                                t2.Start();
                                try
                                {
                                    int created = 0;
                                    foreach (var p in uncovered)
                                    {
                                        if (created >= config.coverage.maxUncoveredMarkers) break;
                                        created += CreateUncoveredMarker(doc, view, p, config.coverage.markerHalfSizeFt, req.runId);
                                    }

                                    report.uncoveredMarkersCreated = created;
                                    t2.Commit();
                                }
                                catch (Exception ex)
                                {
                                    report.warnings.Add($"Visualizer creation failed: {ex.Message}");
                                    t2.RollBack();
                                }
                            }
                        }
                    }
                }
            }

            return Task.FromResult<object>(report);
        }

        private static string ResolveExistingPath(string path)
        {
            if (string.IsNullOrWhiteSpace(path)) return null;
            if (File.Exists(path)) return Path.GetFullPath(path);

            try
            {
                var cwd = Directory.GetCurrentDirectory();
                var p0 = Path.GetFullPath(Path.Combine(cwd, path));
                if (File.Exists(p0)) return p0;
                var p1 = Path.GetFullPath(Path.Combine(cwd, "..", path));
                if (File.Exists(p1)) return p1;
            }
            catch { }

            return null;
        }

        private static string ResolveMappingsPath(string overridePath, string configPath, string configDir)
        {
            var candidate = overridePath;
            if (string.IsNullOrWhiteSpace(candidate)) candidate = configPath;
            if (string.IsNullOrWhiteSpace(candidate)) return null;
            if (Path.IsPathRooted(candidate)) return candidate;
            return Path.GetFullPath(Path.Combine(configDir ?? "", candidate));
        }

        private static T LoadJsonFile<T>(string path, JsonSerializerOptions opts)
        {
            var raw = File.ReadAllText(path);
            raw = raw?.TrimStart('\uFEFF') ?? "";
            return JsonSerializer.Deserialize<T>(raw, opts);
        }

        private static View ResolveView(Document doc, long? viewId)
        {
            if (doc == null) return null;
            if (viewId.HasValue && viewId.Value > 0)
                return doc.GetElement(RevitBridge.Common.ElementIdCompat.Create(viewId.Value)) as View;
            return doc.ActiveView;
        }

        private static Level ResolveLevel(Document doc, string levelName, View view, FireAlarmLayoutReport report)
        {
            Level level = null;
            if (!string.IsNullOrWhiteSpace(levelName))
            {
                level = new FilteredElementCollector(doc)
                    .OfClass(typeof(Level))
                    .Cast<Level>()
                    .FirstOrDefault(l => l.Name.Equals(levelName, StringComparison.OrdinalIgnoreCase));
                if (level == null) report?.warnings?.Add($"Level '{levelName}' not found; falling back to view level.");
            }
            if (level == null && view?.GenLevel != null) level = view.GenLevel;

            if (level == null)
            {
                level = new FilteredElementCollector(doc).OfClass(typeof(Level)).Cast<Level>().FirstOrDefault();
                if (level != null) report?.warnings?.Add($"Falling back to first level '{level.Name}'.");
            }
            return level;
        }

        private static (DeviceTypeMapping mapping, string key) ResolveMapping(Dictionary<string, DeviceTypeMapping> mappings, string deviceKey)
        {
            if (mappings != null && mappings.TryGetValue(deviceKey, out var m)) return (m, deviceKey);
            return (null, deviceKey);
        }

        private static (FamilySymbol symbol, string family, string type) ResolveSymbol(Document doc, (DeviceTypeMapping mapping, string key) mapping, Dictionary<string, FamilySymbol> cache, FireAlarmLayoutReport report)
        {
            if (mapping.mapping == null || string.IsNullOrWhiteSpace(mapping.mapping.type))
            {
                report?.warnings?.Add($"Missing mapping for '{mapping.key}'.");
                return (null, null, null);
            }

            string family = mapping.mapping.family;
            string type = mapping.mapping.type;
            string cacheKey = $"{family ?? ""}::{type}";
            if (cache.TryGetValue(cacheKey, out var cached)) return (cached, family, type);

            FamilySymbol symbol = new FilteredElementCollector(doc)
                .OfClass(typeof(FamilySymbol))
                .Cast<FamilySymbol>()
                .FirstOrDefault(s =>
                    (string.IsNullOrEmpty(family) || s.FamilyName.Equals(family, StringComparison.OrdinalIgnoreCase)) &&
                    s.Name.Equals(type, StringComparison.OrdinalIgnoreCase));

            if (symbol == null)
            {
                report?.warnings?.Add($"Could not resolve FamilySymbol: family='{family ?? "Any"}' type='{type}'.");
                return (null, family, type);
            }

            cache[cacheKey] = symbol;
            return (symbol, family, type);
        }

        private static XYZ GetRoomPlacementPoint(Room room, View view)
        {
            if (room?.Location is LocationPoint lp) return lp.Point;
            var bbox = room?.get_BoundingBox(view);
            if (bbox != null) return (bbox.Min + bbox.Max) * 0.5;
            return XYZ.Zero;
        }

        private static IEnumerable<XYZ> ComputeCorridorPoints(Room corridor, FireAlarmRunConfig config, FireAlarmLayoutReport report)
        {
            var bbox = corridor.get_BoundingBox(null);
            if (bbox == null) yield break;

            var min = bbox.Min;
            var max = bbox.Max;
            var centerY = (min.Y + max.Y) * 0.5;
            var centerX = (min.X + max.X) * 0.5;

            double lenX = Math.Abs(max.X - min.X);
            double lenY = Math.Abs(max.Y - min.Y);
            bool alongX = lenX >= lenY;

            double start = alongX ? min.X : min.Y;
            double end = alongX ? max.X : max.Y;
            double cross = alongX ? centerY : centerX;

            double offset = Math.Max(0, config?.placement?.corridorEndOffsetFt ?? 0);
            double spacing = Math.Max(1, config?.placement?.corridorMaxSpacingFt ?? 100);

            double a = start + offset;
            double b = end - offset;
            if (b < a)
            {
                a = (start + end) * 0.5;
                b = a;
            }

            var points = new List<XYZ>();
            for (double t = a; t <= b + 1e-6; t += spacing)
            {
                XYZ p = alongX ? new XYZ(t, cross, min.Z) : new XYZ(cross, t, min.Z);
                var inside = FindPointInRoomNear(corridor, p, maxSearchFt: 6, stepFt: 1.0);
                if (inside != null) points.Add(inside);
            }

            if (points.Count == 0)
            {
                XYZ p = GetRoomPlacementPoint(corridor, null);
                points.Add(p);
                report?.warnings?.Add($"Corridor '{corridor.Number} {corridor.Name}' centerline approximation failed; falling back to room point.");
            }

            foreach (var p in points) yield return p;
        }

        private static XYZ FindPointInRoomNear(Room room, XYZ seed, double maxSearchFt, double stepFt)
        {
            if (room.IsPointInRoom(seed)) return seed;

            var center = seed;
            int steps = Math.Max(1, (int)Math.Ceiling(maxSearchFt / Math.Max(0.1, stepFt)));
            for (int r = 1; r <= steps; r++)
            {
                double d = r * stepFt;
                var candidates = new[]
                {
                    new XYZ(center.X + d, center.Y, center.Z),
                    new XYZ(center.X - d, center.Y, center.Z),
                    new XYZ(center.X, center.Y + d, center.Z),
                    new XYZ(center.X, center.Y - d, center.Z),
                    new XYZ(center.X + d, center.Y + d, center.Z),
                    new XYZ(center.X + d, center.Y - d, center.Z),
                    new XYZ(center.X - d, center.Y + d, center.Z),
                    new XYZ(center.X - d, center.Y - d, center.Z),
                };
                foreach (var c in candidates)
                {
                    if (room.IsPointInRoom(c)) return c;
                }
            }
            return null;
        }

        private static bool CanCreateDetailInView(View view)
        {
            if (view == null) return false;
            switch (view.ViewType)
            {
                case ViewType.FloorPlan:
                case ViewType.CeilingPlan:
                case ViewType.EngineeringPlan:
                case ViewType.AreaPlan:
                case ViewType.Detail:
                case ViewType.Section:
                    return true;
                default:
                    return false;
            }
        }

        private static List<XYZ> ComputeUncoveredPoints(List<Room> rooms, List<XYZ> devicePoints, FireAlarmRunConfig config)
        {
            var uncovered = new List<XYZ>();
            double radius = Math.Max(0.1, config?.coverage?.strobeRadiusFt ?? 0);
            double spacing = Math.Max(0.5, config?.coverage?.sampleSpacingFt ?? 4);

            foreach (var room in rooms)
            {
                if (room.Area <= 0) continue;

                var classRes = RoomClassifier.Classify(room.Name, room.Area, config);
                var notify = NotificationRequirement.Decide(classRes.roomClass, room.Area, config);
                if (notify.decision != NotifyDecision.REQUIRE) continue;

                var bbox = room.get_BoundingBox(null);
                if (bbox == null) continue;

                for (double x = bbox.Min.X; x <= bbox.Max.X; x += spacing)
                {
                    for (double y = bbox.Min.Y; y <= bbox.Max.Y; y += spacing)
                    {
                        var p = new XYZ(x, y, bbox.Min.Z);
                        if (!room.IsPointInRoom(p)) continue;

                        bool covered = false;
                        foreach (var dp in devicePoints)
                        {
                            var dx = p.X - dp.X;
                            var dy = p.Y - dp.Y;
                            var dist2d = Math.Sqrt(dx * dx + dy * dy);
                            if (dist2d <= radius)
                            {
                                covered = true;
                                break;
                            }
                        }

                        if (!covered)
                        {
                            uncovered.Add(p);
                            if (uncovered.Count >= config.coverage.maxUncoveredMarkers) return uncovered;
                        }
                    }
                }
            }

            return uncovered;
        }

        private static int CreateUncoveredMarker(Document doc, View view, XYZ p, double halfSizeFt, string runId)
        {
            int created = 0;
            double s = Math.Max(0.05, halfSizeFt);

            var l1 = Line.CreateBound(new XYZ(p.X - s, p.Y, p.Z), new XYZ(p.X + s, p.Y, p.Z));
            var l2 = Line.CreateBound(new XYZ(p.X, p.Y - s, p.Z), new XYZ(p.X, p.Y + s, p.Z));

            var c1 = doc.Create.NewDetailCurve(view, l1);
            var c2 = doc.Create.NewDetailCurve(view, l2);

            TagElement(c1, runId, module: "FireAlarm", layer: "UNCOVERED", kind: "VIS_MARKER", roomId: null);
            TagElement(c2, runId, module: "FireAlarm", layer: "UNCOVERED", kind: "VIS_MARKER", roomId: null);

            created += 2;
            return created;
        }

        private static void TagElement(Element e, string runId, string module, string layer, string kind, long? roomId)
        {
            if (e == null) return;

            var parts = new List<string>
            {
                "RO_FA",
                $"runId={runId}",
            };
            if (!string.IsNullOrWhiteSpace(module)) parts.Add($"module={module}");
            if (!string.IsNullOrWhiteSpace(layer)) parts.Add($"layer={layer}");
            if (!string.IsNullOrWhiteSpace(kind)) parts.Add($"kind={kind}");
            if (roomId.HasValue) parts.Add($"roomId={roomId.Value}");

            string tag = string.Join(";", parts);

            TrySetStringParam(e, BuiltInParameter.ALL_MODEL_INSTANCE_COMMENTS, tag);
            TrySetStringParam(e, "Comments", tag);
        }

        private static void TrySetStringParam(Element e, BuiltInParameter bip, string value)
        {
            try
            {
                var p = e.get_Parameter(bip);
                if (p == null || p.IsReadOnly) return;
                if (p.StorageType == StorageType.String) p.Set(value ?? "");
            }
            catch { }
        }

        private static void TrySetStringParam(Element e, string name, string value)
        {
            try
            {
                var p = e.LookupParameter(name);
                if (p == null || p.IsReadOnly) return;
                if (p.StorageType == StorageType.String) p.Set(value ?? "");
            }
            catch { }
        }
    }
}
