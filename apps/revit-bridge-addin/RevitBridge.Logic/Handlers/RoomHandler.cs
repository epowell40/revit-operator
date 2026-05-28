using System;
using System.Linq;
using System.Collections.Generic;
using System.Threading.Tasks;
using Autodesk.Revit.DB;
using Autodesk.Revit.DB.Architecture;
using Autodesk.Revit.DB.Mechanical;
using Autodesk.Revit.UI;
using RevitBridge.Common;
using System.Text.Json;
using RevitBridge.Logic.Handlers.Core;

namespace RevitBridge.Logic.Handlers
{
    public class RoomHandler : IRequestHandler
    {
        internal sealed class SpatialBoundaryExport
        {
            public object? location { get; set; }
            public List<object> boundaryLoops { get; set; } = new List<object>();
            public object? boundary { get; set; }
            public List<string> warnings { get; set; } = new List<string>();
        }

        public class RoomRequest
        {
            public string action { get; set; } // "list", "detail"
            public string levelName { get; set; }
            public string roomNumber { get; set; }
            public int? max { get; set; }
            public List<int> roomIds { get; set; }
            public string spatialKindPreference { get; set; } = "auto";

            // detail options (v2)
            public long? viewId { get; set; } // defaults to active view
            public bool includeBoundaryElementIds { get; set; } = true;
        }

        public Task<object> Handle(UIApplication app, string jsonData)
        {
            var doc = app.ActiveUIDocument.Document;
            var req = JsonSerializer.Deserialize<RoomRequest>(jsonData, new JsonSerializerOptions { PropertyNameCaseInsensitive = true });

            if (req == null) throw new ArgumentException("Invalid request");
            string action = req.action?.ToLower() ?? "list";

            if (action == "detail")
            {
                var ids = req.roomIds;
                if ((ids == null || ids.Count == 0) && !string.IsNullOrWhiteSpace(req.roomNumber))
                {
                    var resolved = SpatialElementResolver.ResolveByNumber(doc, req.roomNumber, req.spatialKindPreference ?? "auto");
                    if (resolved.Element != null)
                    {
                        ids = new List<int> { checked((int)ElementIdCompat.GetValue(resolved.Element.Id)) };
                    }
                }

                var view = ResolveView(doc, app.ActiveUIDocument?.ActiveView, req.viewId);
                return Task.FromResult(GetRoomDetails(doc, ids, view, req.includeBoundaryElementIds));
            }
            else
            {
                return Task.FromResult(ListSpatialElements(doc, req.levelName, req.roomNumber, req.max, req.spatialKindPreference));
            }
        }

        private static string NormalizeNumericRoomNumber(string s)
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

        private static View? ResolveView(Document doc, View? activeView, long? viewId)
        {
            if (viewId.HasValue && viewId.Value != 0)
                return doc.GetElement(RevitBridge.Common.ElementIdCompat.Create(viewId.Value)) as View;
            return activeView;
        }

        private static Room? FindRoomByNumber(Document doc, string roomNumber)
        {
            var q = (roomNumber ?? "").Trim();
            if (q.Length == 0) return null;
            var qNorm = NormalizeNumericRoomNumber(q);

            var collector = new FilteredElementCollector(doc).OfCategory(BuiltInCategory.OST_Rooms);
            foreach (var room in collector.Cast<Room>())
            {
                var n = (room.Number ?? "").Trim();
                if (n.Equals(q, StringComparison.OrdinalIgnoreCase)) return room;
                var nNorm = NormalizeNumericRoomNumber(n);
                if (nNorm.Equals(qNorm, StringComparison.OrdinalIgnoreCase)) return room;
            }

            return null;
        }

        private object ListSpatialElements(Document doc, string levelName, string roomNumber, int? max, string? spatialKindPreference)
        {
            var cap = max.HasValue && max.Value > 0 ? Math.Min(max.Value, 5000) : int.MaxValue;
            var spatialKind = (spatialKindPreference ?? "auto").Trim().ToLowerInvariant();
            var rows = new List<object>();

            if (spatialKind != "space")
            {
                rows.AddRange(FilterSpatialRows(
                    new FilteredElementCollector(doc).OfCategory(BuiltInCategory.OST_Rooms).Cast<Room>().Cast<SpatialElement>(),
                    levelName,
                    roomNumber,
                    cap,
                    "Room"));
            }

            if ((spatialKind == "space" || spatialKind == "auto") && rows.Count == 0)
            {
                rows.AddRange(FilterSpatialRows(
                    new FilteredElementCollector(doc).OfCategory(BuiltInCategory.OST_MEPSpaces).Cast<Space>().Cast<SpatialElement>(),
                    levelName,
                    roomNumber,
                    cap,
                    "Space"));
            }

            return rows.Take(cap).ToList();
        }

        private object GetRoomDetails(Document doc, List<int> ids, View? view, bool includeBoundaryElementIds)
        {
            if (ids == null || ids.Count == 0) return new List<object>();

            var result = new List<object>();

            foreach (int id in ids)
            {
                var el = doc.GetElement(RevitBridge.Common.ElementIdCompat.Create(id));
                if (el is SpatialElement spatial)
                {
                    var boundaryExport = BuildSpatialBoundaryExport(spatial, view, includeBoundaryElementIds);

                    // Get Doors
                    var doors = spatial is Room room
                        ? GetDoorsForRoom(doc, room).Select(d => new
                        {
                            id = RevitBridge.Common.ElementIdCompat.GetValue(d.Id),
                            mark = d.get_Parameter(BuiltInParameter.DOOR_NUMBER)?.AsString() ?? d.get_Parameter(BuiltInParameter.ALL_MODEL_MARK)?.AsString(),
                            rating = d.LookupParameter("Door Rating")?.AsString() ?? d.get_Parameter(BuiltInParameter.FIRE_RATING)?.AsString(),
                            hardware = d.LookupParameter("Hardware")?.AsString(),
                            doorControl = d.LookupParameter("Door Control B")?.AsString(),
                            comments = d.get_Parameter(BuiltInParameter.ALL_MODEL_INSTANCE_COMMENTS)?.AsString(),
                            typeId = RevitBridge.Common.ElementIdCompat.GetValue(d.GetTypeId()),
                            typeName = (doc.GetElement(d.GetTypeId()) as ElementType)?.Name,
                            familyName = (doc.GetElement(d.GetTypeId()) as FamilySymbol)?.FamilyName ?? (doc.GetElement(d.GetTypeId()) as FamilySymbol)?.Family?.Name,
                            isDoubleGuess = ((doc.GetElement(d.GetTypeId()) as ElementType)?.Name ?? "").IndexOf("double", StringComparison.OrdinalIgnoreCase) >= 0 ||
                                           ((doc.GetElement(d.GetTypeId()) as ElementType)?.Name ?? "").IndexOf("dbl", StringComparison.OrdinalIgnoreCase) >= 0
                        }).Cast<object>().ToList()
                        : new List<object>();

                    result.Add(new
                    {
                        id = RevitBridge.Common.ElementIdCompat.GetValue(spatial.Id),
                        number = GetSpatialNumber(spatial),
                        name = GetSpatialName(spatial),
                        spatialKind = spatial is Room ? "Room" : (spatial is Space ? "Space" : "SpatialElement"),
                        area = GetSpatialArea(spatial),
                        volume = GetSpatialVolume(spatial),
                        unboundedHeight = GetSpatialUnboundedHeight(spatial),
                        upperLimit = GetSpatialUpperLimitName(spatial),
                        limitOffset = GetSpatialLimitOffset(spatial),
                        baseOffset = GetSpatialBaseOffset(spatial),
                        level = GetSpatialLevelName(spatial),
                        location = boundaryExport.location,
                        boundaryLoops = boundaryExport.boundaryLoops,
                        boundary = boundaryExport.boundary,
                        doors = doors,
                        warnings = boundaryExport.warnings
                    });
                }
            }
            return result;
        }

        internal static SpatialBoundaryExport BuildSpatialBoundaryExport(
            SpatialElement spatial,
            View? view,
            bool includeBoundaryElementIds)
        {
            var export = new SpatialBoundaryExport();
            var opts = new SpatialElementBoundaryOptions
            {
                SpatialElementBoundaryLocation = SpatialElementBoundaryLocation.Finish
            };

            var right = (view != null) ? view.RightDirection.Normalize() : XYZ.BasisX;
            var up = (view != null) ? view.UpDirection.Normalize() : XYZ.BasisY;
            var boundaries = new List<object>();
            var loopsV2 = new List<object>();
            var flatSegs = new List<(int loopIndex, int segIndex, long hostId, double midX, double midY, double lenFt, double dirX, double dirY)>();
            var boundaryWarnings = new List<string>();

            if (spatial.Location is LocationPoint lp)
            {
                export.location = new { x = lp.Point.X, y = lp.Point.Y, z = lp.Point.Z };
            }

            try
            {
                var segmentsList = spatial.GetBoundarySegments(opts);
                if (segmentsList != null)
                {
                    var loopIndex = 0;
                    foreach (var segments in segmentsList)
                    {
                        if (segments == null || segments.Count == 0) continue;

                        var loopLegacy = new List<object>();
                        var loopSegs = new List<object>();

                        var segIndex = 0;
                        foreach (var s in segments)
                        {
                            var curve = s?.GetCurve();
                            if (curve == null) continue;

                            var p0 = curve.GetEndPoint(0);
                            var p1 = curve.GetEndPoint(1);

                            var d = p1 - p0;
                            var len = d.GetLength();
                            var dir = len > 1e-9 ? d / len : XYZ.Zero;

                            var mid = (p0 + p1) * 0.5;
                            var midX = mid.DotProduct(right);
                            var midY = mid.DotProduct(up);
                            var dirX = dir.DotProduct(right);
                            var dirY = dir.DotProduct(up);

                            var hostId = RevitBridge.Common.ElementIdCompat.GetValue(s.ElementId);
                            if (hostId <= 0) boundaryWarnings.Add("Room boundary segment with invalid host element id encountered.");

                            loopLegacy.Add(new
                            {
                                elementId = hostId,
                                start = new { x = p0.X, y = p0.Y, z = p0.Z },
                                end = new { x = p1.X, y = p1.Y, z = p1.Z }
                            });

                            loopSegs.Add(new
                            {
                                hostElementId = includeBoundaryElementIds ? hostId : (long?)null,
                                elementId = hostId,
                                start = new { x = p0.X, y = p0.Y, z = p0.Z },
                                end = new { x = p1.X, y = p1.Y, z = p1.Z },
                                midpoint = new { x = mid.X, y = mid.Y, z = mid.Z },
                                direction = new { x = dir.X, y = dir.Y, z = dir.Z },
                                directionInView = new { x = dirX, y = dirY },
                                midpointInView = new { x = midX, y = midY },
                                lengthFt = curve.Length
                            });

                            flatSegs.Add((loopIndex, segIndex, hostId, midX, midY, curve.Length, dirX, dirY));
                            segIndex++;
                        }

                        if (loopLegacy.Count == 0) continue;

                        boundaries.Add(loopLegacy);
                        loopsV2.Add(new { loopIndex, segments = loopSegs });
                        loopIndex++;
                    }
                }
                else
                {
                    boundaryWarnings.Add("Room/Space boundary segments were unavailable for this spatial element.");
                }
            }
            catch (Exception ex)
            {
                boundaryWarnings.Add($"Failed to read Room/Space boundary segments: {ex.Message}");
            }

            export.boundaryLoops = boundaries;
            export.boundary = new
            {
                viewId = RevitBridge.Common.ElementIdCompat.GetValue(view?.Id),
                viewBasis = new
                {
                    right = new { x = right.X, y = right.Y, z = right.Z },
                    up = new { x = up.X, y = up.Y, z = up.Z },
                    note = "midpointInView/directionInView are computed as dot(XYZ, view.RightDirection/UpDirection). Units are feet."
                },
                loops = loopsV2,
                sideClassification = ClassifyBoundarySegments(flatSegs)
            };
            export.warnings = boundaryWarnings;
            return export;
        }

        private IEnumerable<object> FilterSpatialRows(
            IEnumerable<SpatialElement> spatials,
            string levelName,
            string roomNumber,
            int cap,
            string spatialKind)
        {
            var filtered = spatials ?? Enumerable.Empty<SpatialElement>();
            if (!string.IsNullOrWhiteSpace(levelName))
            {
                filtered = filtered.Where(spatial =>
                    GetSpatialLevelName(spatial).IndexOf(levelName, StringComparison.OrdinalIgnoreCase) >= 0);
            }

            if (!string.IsNullOrWhiteSpace(roomNumber))
            {
                var q = roomNumber.Trim();
                var qNorm = NormalizeNumericRoomNumber(q);
                filtered = filtered.Where(spatial =>
                {
                    var number = (GetSpatialNumber(spatial) ?? "").Trim();
                    if (number.Equals(q, StringComparison.OrdinalIgnoreCase)) return true;
                    var nNorm = NormalizeNumericRoomNumber(number);
                    return nNorm.Equals(qNorm, StringComparison.OrdinalIgnoreCase);
                });
            }

            return filtered.Take(cap).Select(spatial => new
            {
                id = ElementIdCompat.GetValue(spatial.Id),
                number = GetSpatialNumber(spatial),
                name = GetSpatialName(spatial),
                area = GetSpatialArea(spatial),
                level = GetSpatialLevelName(spatial),
                spatialKind,
                phase = spatial is Room room ? room.get_Parameter(BuiltInParameter.ROOM_PHASE)?.AsValueString() : null
            });
        }

        internal static string GetSpatialNumber(SpatialElement spatial)
        {
            return spatial switch
            {
                Room room => room.Number,
                Space space => space.Number,
                _ => ""
            };
        }

        internal static string GetSpatialName(SpatialElement spatial)
        {
            return spatial switch
            {
                Room room => room.Name,
                Space space => space.Name,
                _ => spatial.Name
            };
        }

        internal static string GetSpatialLevelName(SpatialElement spatial)
        {
            return spatial switch
            {
                Room room => room.Level?.Name ?? "",
                Space space => space.Level?.Name ?? "",
                _ => ""
            };
        }

        internal static double? GetSpatialArea(SpatialElement spatial)
        {
            return spatial switch
            {
                Room room => room.Area,
                Space space => space.Area,
                _ => null
            };
        }

        internal static double? GetSpatialVolume(SpatialElement spatial)
        {
            return spatial switch
            {
                Room room => room.Volume,
                Space space => space.Volume,
                _ => null
            };
        }

        internal static double? GetSpatialUnboundedHeight(SpatialElement spatial)
        {
            return spatial switch
            {
                Room room => room.UnboundedHeight,
                Space space => space.UnboundedHeight,
                _ => null
            };
        }

        internal static string? GetSpatialUpperLimitName(SpatialElement spatial)
        {
            return spatial switch
            {
                Room room => room.UpperLimit?.Name,
                Space space => space.UpperLimit?.Name,
                _ => null
            };
        }

        internal static double? GetSpatialLimitOffset(SpatialElement spatial)
        {
            return spatial switch
            {
                Room room => room.LimitOffset,
                Space space => space.LimitOffset,
                _ => null
            };
        }

        internal static double? GetSpatialBaseOffset(SpatialElement spatial)
        {
            return spatial switch
            {
                Room room => room.BaseOffset,
                Space space => space.BaseOffset,
                _ => null
            };
        }

        private static object ClassifyBoundarySegments(List<(int loopIndex, int segIndex, long hostId, double midX, double midY, double lenFt, double dirX, double dirY)> segs)
        {
            if (segs == null || segs.Count == 0)
                return new { left = new object[0], right = new object[0], bottom = new object[0], top = new object[0], notes = new[] { "No boundary segments available for classification." } };

            var minX = segs.Min(s => s.midX);
            var maxX = segs.Max(s => s.midX);
            var minY = segs.Min(s => s.midY);
            var maxY = segs.Max(s => s.midY);

            var spanX = Math.Max(1e-9, maxX - minX);
            var spanY = Math.Max(1e-9, maxY - minY);

            var tolX = Math.Max(0.25, 0.02 * spanX);
            var tolY = Math.Max(0.25, 0.02 * spanY);

            bool IsVertical((int loopIndex, int segIndex, long hostId, double midX, double midY, double lenFt, double dirX, double dirY) s) =>
                Math.Abs(s.dirY) >= Math.Abs(s.dirX);

            bool IsHorizontal((int loopIndex, int segIndex, long hostId, double midX, double midY, double lenFt, double dirX, double dirY) s) =>
                Math.Abs(s.dirX) > Math.Abs(s.dirY);

            var vertical = segs.Where(IsVertical).ToList();
            var horizontal = segs.Where(IsHorizontal).ToList();

            var left = vertical.Where(s => s.midX <= minX + tolX).ToList();
            var right = vertical.Where(s => s.midX >= maxX - tolX).ToList();
            var bottom = horizontal.Where(s => s.midY <= minY + tolY).ToList();
            var top = horizontal.Where(s => s.midY >= maxY - tolY).ToList();

            object Pack(string side, List<(int loopIndex, int segIndex, long hostId, double midX, double midY, double lenFt, double dirX, double dirY)> list) =>
                new
                {
                    side,
                    hostElementIds = list.Select(s => s.hostId).Where(id => id > 0).Distinct().ToList(),
                    segments = list.Select(s => new
                    {
                        loopIndex = s.loopIndex,
                        segmentIndex = s.segIndex,
                        hostElementId = s.hostId,
                        midpointInView = new { x = s.midX, y = s.midY },
                        directionInView = new { x = s.dirX, y = s.dirY },
                        lengthFt = s.lenFt
                    }).ToList()
                };

            return new
            {
                extentsInView = new { minX, maxX, minY, maxY },
                tolerancesFt = new { tolX, tolY },
                left = Pack("left", left),
                right = Pack("right", right),
                bottom = Pack("bottom", bottom),
                top = Pack("top", top),
                notes = new[]
                {
                    "Classification uses boundary segment midpoints projected into view basis. For left/right it prefers segments whose direction is more vertical in the view; for top/bottom it prefers more horizontal segments."
                }
            };
        }

        private List<FamilyInstance> GetDoorsForRoom(Document doc, Room room)
        {
            var bbox = room.get_BoundingBox(null);
            if (bbox == null) return new List<FamilyInstance>();

            var outline = new Outline(bbox.Min, bbox.Max);
            var filter = new BoundingBoxIntersectsFilter(outline);

            var doors = new FilteredElementCollector(doc)
                .OfCategory(BuiltInCategory.OST_Doors)
                .OfClass(typeof(FamilyInstance))
                .WherePasses(filter)
                .Cast<FamilyInstance>()
                .Where(d => IsDoorInRoom(d, room))
                .ToList();

            return doors;
        }

        private bool IsDoorInRoom(FamilyInstance door, Room room)
        {
            // Get the phase of the room
            var phaseId = room.get_Parameter(BuiltInParameter.ROOM_PHASE)?.AsElementId();
            if (phaseId == null) return false;
            
            // We can't easily get the Phase object from Id in a simple filter without the Document, 
            // but we have the room, so we can try to get the room's phase.
            // Actually, FamilyInstance.get_Room(Phase) requires a Phase object.
            
            var doc = room.Document;
            var phase = doc.GetElement(phaseId) as Phase;
            if (phase == null) return false;

            var toRoom = door.get_ToRoom(phase);
            var fromRoom = door.get_FromRoom(phase);
            var r = door.get_Room(phase);

            return (toRoom != null && toRoom.Id == room.Id) ||
                   (fromRoom != null && fromRoom.Id == room.Id) ||
                   (r != null && r.Id == room.Id);
        }
    }
}

