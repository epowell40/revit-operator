using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Text.Json;
using System.Threading.Tasks;
using Autodesk.Revit.DB;
using Autodesk.Revit.DB.Architecture;
using Autodesk.Revit.UI;
using RevitBridge.Common;

namespace RevitBridge.Logic.Handlers
{
    public class AlignRoomTopsToCeilingsHandler : IRequestHandler
    {
        public sealed class Params
        {
            public List<string>? roomNumbers { get; set; }
            public string? levelNameContains { get; set; }
            public int? maxRooms { get; set; } = 20000;
            public bool dryRun { get; set; } = true;
            public string? behavior { get; set; } = "allOrNothing"; // allOrNothing | bestEffort
            public double? toleranceFt { get; set; } = null; // default ~1/8"
        }

        public Task<object> Handle(UIApplication app, string jsonData)
        {
            var p = string.IsNullOrWhiteSpace(jsonData) ? new Params() : JsonSerializer.Deserialize<Params>(jsonData);

            var uidoc = app.ActiveUIDocument;
            if (uidoc == null) throw new InvalidOperationException("No active UI document.");
            var doc = uidoc.Document;

            var bestEffort = string.Equals(p?.behavior, "bestEffort", StringComparison.OrdinalIgnoreCase);
            var tol = p?.toleranceFt ?? (1.0 / 96.0); // 1/8 inch

            var warnings = new List<string>();
            var adjustedRoomIds = new List<long>();
            var skipped = new List<object>();
            var changes = new List<object>();

            var ceilings = CollectCeilings(doc);
            if (ceilings.Count == 0) warnings.Add("No ceilings found in the model (OST_Ceilings).");

            var rooms = CollectRooms(doc, p?.roomNumbers, p?.levelNameContains, p?.maxRooms ?? 20000, warnings);

            if (rooms.Count == 0)
            {
                return Task.FromResult<object>(new
                {
                    status = "Ok",
                    dryRun = p?.dryRun ?? true,
                    adjustedRoomIds = new List<long>(),
                    skipped,
                    changes,
                    warnings = warnings.Concat(new[] { "No matching rooms found." }).ToList()
                });
            }

            using (var t = new Transaction(doc, (p?.dryRun ?? true) ? "Align Room Tops To Ceilings (Dry Run)" : "Align Room Tops To Ceilings"))
            {
                t.Start();
                try
                {
                    foreach (var room in rooms)
                    {
                        if (room == null) continue;

                        var id = RevitBridge.Common.ElementIdCompat.GetValue(room.Id);
                        if (room.GroupId != ElementId.InvalidElementId)
                        {
                            skipped.Add(new { roomId = id, roomNumber = room.Number, reason = "InGroup" });
                            if (!bestEffort) throw new Exception($"Room {room.Number} is in a group.");
                            continue;
                        }

                        if (!TryGetRoomBaseTop(room, out var baseZ, out var currentTopZ, out var currentMode))
                        {
                            skipped.Add(new { roomId = id, roomNumber = room.Number, reason = "RoomHeightUnavailable" });
                            if (!bestEffort) throw new Exception($"Room {room.Number} height not available.");
                            continue;
                        }

                        if (!TryFindPrimaryCeilingForRoom(room, ceilings, baseZ, out var ceiling, out var ceilingBottomZ, out var ceilingScore))
                        {
                            skipped.Add(new { roomId = id, roomNumber = room.Number, reason = "NoCeilingFound" });
                            if (!bestEffort) throw new Exception($"No ceiling found for room {room.Number}.");
                            continue;
                        }

                        var delta = ceilingBottomZ - currentTopZ;
                        if (Math.Abs(delta) <= tol)
                        {
                            changes.Add(new
                            {
                                roomId = id,
                                roomNumber = room.Number,
                                roomName = room.Name,
                                level = room.Level?.Name,
                                status = "NoChange",
                                baseZ,
                                currentTopZ,
                                ceilingId = RevitBridge.Common.ElementIdCompat.GetValue(ceiling.Id),
                                ceilingBottomZ,
                                deltaZ = delta,
                                roomTopMode = currentMode,
                                ceilingScore
                            });
                            continue;
                        }

                        if (ceilingBottomZ <= baseZ + 0.1)
                        {
                            skipped.Add(new { roomId = id, roomNumber = room.Number, reason = "CeilingBelowRoomBase" });
                            if (!bestEffort) throw new Exception($"Ceiling bottom is below room base for room {room.Number}.");
                            continue;
                        }

                        if (!TrySetRoomTop(room, baseZ, ceilingBottomZ, warnings, out var setMode, out var targetTopZ))
                        {
                            skipped.Add(new { roomId = id, roomNumber = room.Number, reason = "SetRoomTopFailed" });
                            if (!bestEffort) throw new Exception($"Failed to set top for room {room.Number}.");
                            continue;
                        }

                        adjustedRoomIds.Add(id);
                        changes.Add(new
                        {
                            roomId = id,
                            roomNumber = room.Number,
                            roomName = room.Name,
                            level = room.Level?.Name,
                            status = "Adjusted",
                            baseZ,
                            currentTopZ,
                            newTopZ = targetTopZ,
                            deltaZ = targetTopZ - currentTopZ,
                            roomTopMode = currentMode,
                            setMode,
                            ceilingId = RevitBridge.Common.ElementIdCompat.GetValue(ceiling.Id),
                            ceilingBottomZ,
                            ceilingScore
                        });
                    }

                    if (p?.dryRun ?? true)
                    {
                        t.RollBack();
                        return Task.FromResult<object>(new
                        {
                            status = "Dry Run",
                            dryRun = true,
                            adjustedRoomIds = adjustedRoomIds.Distinct().OrderBy(x => x).ToList(),
                            skipped,
                            changes,
                            warnings,
                            rolledBack = true
                        });
                    }

                    if (!bestEffort && skipped.Count > 0)
                    {
                        t.RollBack();
                        return Task.FromResult<object>(new
                        {
                            status = "Failed",
                            dryRun = false,
                            adjustedRoomIds = adjustedRoomIds.Distinct().OrderBy(x => x).ToList(),
                            skipped,
                            changes,
                            warnings,
                            rolledBack = true,
                            error = "allOrNothing: rolled back due to failures."
                        });
                    }

                    t.Commit();
                    return Task.FromResult<object>(new
                    {
                        status = "Adjusted",
                        dryRun = false,
                        adjustedRoomIds = adjustedRoomIds.Distinct().OrderBy(x => x).ToList(),
                        skipped,
                        changes,
                        warnings,
                        rolledBack = false
                    });
                }
                catch (Exception ex)
                {
                    try { t.RollBack(); } catch { }
                    return Task.FromResult<object>(new
                    {
                        status = (p?.dryRun ?? true) ? "Dry Run" : "Failed",
                        dryRun = p?.dryRun ?? true,
                        adjustedRoomIds = adjustedRoomIds.Distinct().OrderBy(x => x).ToList(),
                        skipped,
                        changes,
                        warnings,
                        rolledBack = true,
                        error = ex.Message
                    });
                }
            }
        }

        private static List<Ceiling> CollectCeilings(Document doc)
        {
            try
            {
                return new FilteredElementCollector(doc)
                    .OfCategory(BuiltInCategory.OST_Ceilings)
                    .WhereElementIsNotElementType()
                    .OfType<Ceiling>()
                    .ToList();
            }
            catch
            {
                // fallback: use Elements (some ceiling subclasses)
                return new FilteredElementCollector(doc)
                    .OfCategory(BuiltInCategory.OST_Ceilings)
                    .WhereElementIsNotElementType()
                    .Select(e => e as Ceiling)
                    .Where(e => e != null)
                    .ToList();
            }
        }

        private static List<Room> CollectRooms(Document doc, List<string>? roomNumbers, string? levelNameContains, int max, List<string> warnings)
        {
            var rooms = new FilteredElementCollector(doc)
                .OfCategory(BuiltInCategory.OST_Rooms)
                .WhereElementIsNotElementType()
                .OfType<Room>()
                .ToList();

            if (!string.IsNullOrWhiteSpace(levelNameContains))
            {
                var q = levelNameContains.Trim();
                rooms = rooms.Where(r => (r.Level?.Name ?? "").IndexOf(q, StringComparison.OrdinalIgnoreCase) >= 0).ToList();
            }

            if (roomNumbers != null && roomNumbers.Count > 0)
            {
                var wanted = new HashSet<string>(roomNumbers.Where(x => !string.IsNullOrWhiteSpace(x)).Select(NormalizeRoomNumber), StringComparer.OrdinalIgnoreCase);
                rooms = rooms.Where(r => wanted.Contains(NormalizeRoomNumber(r.Number ?? ""))).ToList();
            }

            if (max > 0 && rooms.Count > max)
            {
                warnings.Add($"Room list truncated to maxRooms={max}.");
                rooms = rooms.Take(max).ToList();
            }

            return rooms;
        }

        private static bool TryGetRoomBaseTop(Room room, out double baseZ, out double topZ, out string mode)
        {
            baseZ = 0.0;
            topZ = 0.0;
            mode = "Unknown";
            try
            {
                if (room.Level == null) return false;
                baseZ = room.Level.Elevation + room.BaseOffset;

                if (room.UpperLimit != null)
                {
                    topZ = room.UpperLimit.Elevation + room.LimitOffset;
                    mode = "UpperLimit+LimitOffset";
                    return true;
                }

                try
                {
                    topZ = baseZ + room.UnboundedHeight;
                    mode = "UnboundedHeight";
                    return true;
                }
                catch
                {
                    // ignore; fall back to bbox
                }

                var bb = room.get_BoundingBox(null);
                if (bb != null)
                {
                    topZ = bb.Max.Z;
                    mode = "BboxMaxZ";
                    return true;
                }
            }
            catch { }
            return false;
        }

        private static bool TrySetRoomTop(Room room, double baseZ, double desiredTopZ, List<string> warnings, out string setMode, out double resultingTopZ)
        {
            setMode = "Unknown";
            resultingTopZ = desiredTopZ;
            try
            {
                if (room.Level == null) return false;

                // Prefer upper-limit mode (more typical / stable).
                var upper = room.UpperLimit;
                if (upper == null)
                {
                    var next = FindNextLevel(room.Document, room.Level);
                    if (next != null)
                    {
                        try
                        {
                            room.UpperLimit = next;
                            upper = next;
                        }
                        catch
                        {
                            warnings.Add($"Room {room.Number}: failed to set UpperLimit; cannot adjust without an UpperLimit level.");
                            upper = null;
                        }
                    }
                }

                if (upper != null)
                {
                    var offset = desiredTopZ - upper.Elevation;
                    room.LimitOffset = offset;
                    setMode = "SetLimitOffset";
                    resultingTopZ = upper.Elevation + room.LimitOffset;
                    return true;
                }

                // In Revit 2024 API, Room.UnboundedHeight is read-only; require an UpperLimit.
                return false;
            }
            catch
            {
                return false;
            }
        }

        private static Level? FindNextLevel(Document doc, Level baseLevel)
        {
            try
            {
                var elev = baseLevel.Elevation;
                return new FilteredElementCollector(doc)
                    .OfClass(typeof(Level))
                    .Cast<Level>()
                    .Where(l => l.Elevation > elev + 1e-6)
                    .OrderBy(l => l.Elevation)
                    .FirstOrDefault();
            }
            catch
            {
                return null;
            }
        }

        private static bool TryFindPrimaryCeilingForRoom(Room room, List<Ceiling> ceilings, double baseZ, out Ceiling ceiling, out double ceilingBottomZ, out object ceilingScore)
        {
            ceiling = null;
            ceilingBottomZ = 0.0;
            ceilingScore = new { };

            if (ceilings == null || ceilings.Count == 0) return false;

            BoundingBoxXYZ roomBb = null;
            try { roomBb = room.get_BoundingBox(null); } catch { roomBb = null; }
            if (roomBb == null) return false;

            var candidates = new List<(Ceiling c, double bottomZ, double area, double centerX, double centerY)>();

            foreach (var c in ceilings)
            {
                if (c == null) continue;
                BoundingBoxXYZ bb = null;
                try { bb = c.get_BoundingBox(null); } catch { bb = null; }
                if (bb == null) continue;

                // quick XY overlap filter (ignore Z, ceilings are above)
                if (bb.Max.X < roomBb.Min.X - 0.5) continue;
                if (bb.Min.X > roomBb.Max.X + 0.5) continue;
                if (bb.Max.Y < roomBb.Min.Y - 0.5) continue;
                if (bb.Min.Y > roomBb.Max.Y + 0.5) continue;

                var center = (bb.Min + bb.Max) * 0.5;
                var test = new XYZ(center.X, center.Y, baseZ + 0.1);
                bool inFootprint;
                try { inFootprint = room.IsPointInRoom(test); }
                catch { inFootprint = false; }
                if (!inFootprint) continue;

                var bottomZ = bb.Min.Z;
                var area = TryGetCeilingAreaSqft(c);
                candidates.Add((c, bottomZ, area, center.X, center.Y));
            }

            if (candidates.Count == 0) return false;

            // Primary ceiling: largest computed area, then lowest bottom elevation.
            var best = candidates
                .OrderByDescending(x => x.area)
                .ThenBy(x => x.bottomZ)
                .First();

            ceiling = best.c;
            ceilingBottomZ = best.bottomZ;
            ceilingScore = new
            {
                areaSqft = best.area,
                bottomZ = best.bottomZ,
                centerX = best.centerX,
                centerY = best.centerY
            };
            return true;
        }

        private static double TryGetCeilingAreaSqft(Ceiling c)
        {
            try
            {
                var p = c.get_Parameter(BuiltInParameter.HOST_AREA_COMPUTED);
                if (p != null && p.StorageType == StorageType.Double)
                {
                    var a = p.AsDouble();
                    if (a > 0) return a;
                }
            }
            catch { }

            try
            {
                // fallback: parse "Area" parameter string if needed (best-effort)
                var p = c.LookupParameter("Area");
                if (p != null)
                {
                    var s = p.AsValueString();
                    if (!string.IsNullOrWhiteSpace(s) && double.TryParse(s, NumberStyles.Float, CultureInfo.CurrentCulture, out var v))
                        return Math.Max(0, v);
                }
            }
            catch { }

            return 0.0;
        }

        private static string NormalizeRoomNumber(string s)
        {
            if (s == null) return "";
            var t = s.Trim();
            if (t.Length == 0) return "";
            for (int i = 0; i < t.Length; i++)
            {
                if (!char.IsDigit(t[i])) return t;
            }
            var trimmed = t.TrimStart('0');
            return trimmed.Length == 0 ? "0" : trimmed;
        }
    }
}
