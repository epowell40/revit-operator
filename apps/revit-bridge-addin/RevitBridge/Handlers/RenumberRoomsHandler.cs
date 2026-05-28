using System;
using System.Collections.Generic;
using System.Linq;
using System.Text.Json;
using System.Threading.Tasks;
using Autodesk.Revit.DB;
using Autodesk.Revit.DB.Architecture;
using Autodesk.Revit.UI;

namespace RevitBridge.Handlers
{
    public sealed class RenumberRoomsHandler : IRequestHandler
    {
        public sealed class Params
        {
            public string? levelNameContains { get; set; }
            public int? startNumber { get; set; }
            public int? increment { get; set; }
            public int? digits { get; set; }
            public string? prefix { get; set; }
            public string? suffix { get; set; }
            public string? nameContains { get; set; }
            public int? max { get; set; }
            public bool? dryRun { get; set; }
        }

        private sealed class PlanEntry
        {
            public long roomId { get; set; }
            public string? levelName { get; set; }
            public string? roomName { get; set; }
            public string? current { get; set; }
            public string? next { get; set; }
        }

        private sealed class ApplyError
        {
            public long roomId { get; set; }
            public string? current { get; set; }
            public string? next { get; set; }
            public string error { get; set; } = "";
        }

        public Task<object> Handle(UIApplication app, string jsonData)
        {
            var opts = new JsonSerializerOptions { PropertyNameCaseInsensitive = true };
            var p = string.IsNullOrWhiteSpace(jsonData)
                ? new Params()
                : (JsonSerializer.Deserialize<Params>(jsonData, opts) ?? new Params());

            var doc = app.ActiveUIDocument?.Document
                ?? throw new InvalidOperationException("No active Revit document.");

            var startNumber = p.startNumber ?? 101;
            var increment = p.increment ?? 1;
            var digits = p.digits ?? 3;
            var dryRun = p.dryRun ?? false;
            var levelNameContains = (p.levelNameContains ?? "").Trim();
            var nameContains = (p.nameContains ?? "").Trim();
            var prefix = p.prefix ?? "";
            var suffix = p.suffix ?? "";

            if (startNumber < 0) throw new InvalidOperationException("renumber-rooms.startNumber must be >= 0.");
            if (increment <= 0) throw new InvalidOperationException("renumber-rooms.increment must be > 0.");
            if (digits <= 0 || digits > 12) throw new InvalidOperationException("renumber-rooms.digits must be between 1 and 12.");
            if (p.max.HasValue && p.max.Value <= 0) throw new InvalidOperationException("renumber-rooms.max must be > 0 when provided.");
            if (p.max.HasValue && p.max.Value > 10000) throw new InvalidOperationException("renumber-rooms.max is too large (max 10000).");

            var rooms = new FilteredElementCollector(doc)
                .OfCategory(BuiltInCategory.OST_Rooms)
                .OfClass(typeof(SpatialElement))
                .WhereElementIsNotElementType()
                .Cast<SpatialElement>()
                .OfType<Room>()
                .Where(r => r.Area > 0)
                .ToList();

            if (!string.IsNullOrWhiteSpace(levelNameContains))
            {
                rooms = rooms
                    .Where(r => (r.Level?.Name ?? "").IndexOf(levelNameContains, StringComparison.OrdinalIgnoreCase) >= 0)
                    .ToList();
            }

            if (!string.IsNullOrWhiteSpace(nameContains))
            {
                rooms = rooms
                    .Where(r => (r.Name ?? "").IndexOf(nameContains, StringComparison.OrdinalIgnoreCase) >= 0)
                    .ToList();
            }

            rooms = rooms
                .OrderBy(r => r.Level?.Name ?? "", StringComparer.OrdinalIgnoreCase)
                .ThenBy(r => r.Number ?? "", StringComparer.OrdinalIgnoreCase)
                .ThenBy(r => r.Name ?? "", StringComparer.OrdinalIgnoreCase)
                .ThenBy(r => RevitBridge.Common.ElementIdCompat.GetValue(r.Id))
                .ToList();

            if (p.max.HasValue) rooms = rooms.Take(p.max.Value).ToList();

            var plan = BuildPlan(rooms, startNumber, increment, digits, prefix, suffix);
            var unchangedCount = plan.Count(x => string.Equals(x.current ?? "", x.next ?? "", StringComparison.Ordinal));
            var plannedChangeCount = plan.Count - unchangedCount;

            if (dryRun)
            {
                return Task.FromResult<object>(new
                {
                    status = "Dry Run",
                    dryRun = true,
                    summary = new
                    {
                        totalRooms = plan.Count,
                        plannedChangeCount,
                        unchangedCount
                    },
                    plan = plan.Select(x => new { roomId = x.roomId, current = x.current, next = x.next }).ToList()
                });
            }

            var changed = new List<object>();
            var errors = new List<ApplyError>();

            using (var t = new Transaction(doc, "Renumber Rooms"))
            {
                t.Start();
                for (int i = 0; i < plan.Count; i++)
                {
                    var entry = plan[i];
                    var room = rooms[i];

                    if (string.Equals(entry.current ?? "", entry.next ?? "", StringComparison.Ordinal))
                    {
                        continue;
                    }

                    try
                    {
                        var pNumber = room.get_Parameter(BuiltInParameter.ROOM_NUMBER);
                        if (pNumber == null)
                        {
                            errors.Add(new ApplyError
                            {
                                roomId = entry.roomId,
                                current = entry.current,
                                next = entry.next,
                                error = "ROOM_NUMBER parameter not found."
                            });
                            continue;
                        }

                        if (pNumber.IsReadOnly)
                        {
                            errors.Add(new ApplyError
                            {
                                roomId = entry.roomId,
                                current = entry.current,
                                next = entry.next,
                                error = "ROOM_NUMBER parameter is read-only."
                            });
                            continue;
                        }

                        if (!pNumber.Set(entry.next ?? ""))
                        {
                            errors.Add(new ApplyError
                            {
                                roomId = entry.roomId,
                                current = entry.current,
                                next = entry.next,
                                error = "Revit rejected the room number value."
                            });
                            continue;
                        }

                        changed.Add(new
                        {
                            roomId = entry.roomId,
                            before = entry.current,
                            after = entry.next
                        });
                    }
                    catch (Exception ex)
                    {
                        errors.Add(new ApplyError
                        {
                            roomId = entry.roomId,
                            current = entry.current,
                            next = entry.next,
                            error = ex.Message
                        });
                    }
                }

                t.Commit();
            }

            return Task.FromResult<object>(new
            {
                status = errors.Count > 0 ? "CompletedWithErrors" : "Success",
                dryRun = false,
                summary = new
                {
                    totalRooms = plan.Count,
                    plannedChangeCount,
                    changedCount = changed.Count,
                    unchangedCount,
                    errorCount = errors.Count
                },
                changed,
                errors
            });
        }

        private static List<PlanEntry> BuildPlan(
            List<Room> rooms,
            int startNumber,
            int increment,
            int digits,
            string prefix,
            string suffix)
        {
            var plan = new List<PlanEntry>(rooms.Count);
            long sequence = startNumber;

            for (int i = 0; i < rooms.Count; i++)
            {
                var room = rooms[i];
                var next = prefix + sequence.ToString("D" + digits) + suffix;
                plan.Add(new PlanEntry
                {
                    roomId = RevitBridge.Common.ElementIdCompat.GetValue(room.Id),
                    levelName = room.Level?.Name,
                    roomName = room.Name,
                    current = room.Number ?? "",
                    next = next
                });

                try
                {
                    checked { sequence += increment; }
                }
                catch (OverflowException)
                {
                    throw new InvalidOperationException("renumber-rooms sequence overflow. Reduce startNumber/increment/max.");
                }
            }

            return plan;
        }
    }
}
