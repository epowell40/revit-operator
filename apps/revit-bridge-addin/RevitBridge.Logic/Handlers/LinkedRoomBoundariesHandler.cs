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
    public sealed class LinkedRoomBoundariesHandler : IRequestHandler
    {
        public sealed class Request
        {
            public string? levelName { get; set; }
            public string? linkedModelNameContains { get; set; }
            public string? roomNumber { get; set; }
            public string? roomNameContains { get; set; }
            public int? maxRooms { get; set; }
            public bool includeBoundarySegmentMetadata { get; set; } = true;
        }

        public Task<object> Handle(UIApplication app, string jsonData)
        {
            var doc = app.ActiveUIDocument.Document;
            var req = JsonSerializer.Deserialize<Request>(
                string.IsNullOrWhiteSpace(jsonData) ? "{}" : jsonData,
                new JsonSerializerOptions { PropertyNameCaseInsensitive = true }) ?? new Request();

            var maxRooms = req.maxRooms.HasValue && req.maxRooms.Value > 0
                ? Math.Min(req.maxRooms.Value, 5000)
                : 500;
            var rooms = new List<object>();
            var roomsWithBoundaries = 0;
            var linksSearched = new List<object>();
            var skippedLinks = new List<object>();
            var warnings = new List<string>();
            var links = new FilteredElementCollector(doc)
                .OfClass(typeof(RevitLinkInstance))
                .Cast<RevitLinkInstance>()
                .ToList();

            foreach (var link in links)
            {
                Document? linkDoc = null;
                try { linkDoc = link.GetLinkDocument(); } catch { }
                var linkName = link.Name ?? "";
                var title = linkDoc?.Title ?? "";
                var path = SafeDocumentPath(linkDoc);

                if (linkDoc == null)
                {
                    skippedLinks.Add(new { linkInstanceId = ElementIdCompat.GetValue(link.Id), name = linkName, reason = "link_document_unavailable" });
                    continue;
                }

                if (!MatchesContains(linkName, req.linkedModelNameContains) &&
                    !MatchesContains(title, req.linkedModelNameContains) &&
                    !MatchesContains(path, req.linkedModelNameContains))
                {
                    skippedLinks.Add(new { linkInstanceId = ElementIdCompat.GetValue(link.Id), name = linkName, documentTitle = title, reason = "linked_model_filter_not_matched" });
                    continue;
                }

                var transform = GetLinkTransform(link);
                var linkRoomCount = 0;
                var linkBoundaryCount = 0;
                var collector = new FilteredElementCollector(linkDoc)
                    .OfCategory(BuiltInCategory.OST_Rooms)
                    .WhereElementIsNotElementType()
                    .Cast<Room>();

                foreach (var room in collector)
                {
                    if (rooms.Count >= maxRooms) break;
                    if (!PassesRoomFilters(room, req)) continue;

                    linkRoomCount++;
                    var roomWarnings = new List<string>();
                    var boundary = BuildBoundaryPayload(linkDoc, room, transform, req.includeBoundarySegmentMetadata, roomWarnings);
                    var loopCount = boundary.boundaryLoops.Count;
                    if (loopCount > 0)
                    {
                        linkBoundaryCount++;
                        roomsWithBoundaries++;
                    }

                    rooms.Add(new
                    {
                        id = ElementIdCompat.GetValue(room.Id),
                        uniqueId = room.UniqueId,
                        sourceScopedId = $"{ElementIdCompat.GetValue(link.Id)}:{ElementIdCompat.GetValue(room.Id)}",
                        number = room.Number,
                        name = room.Name,
                        levelName = room.Level?.Name ?? "",
                        area = SafeArea(room),
                        volume = SafeVolume(room),
                        location = BuildLocation(room, transform),
                        source = new
                        {
                            scope = "linked",
                            linkInstanceId = ElementIdCompat.GetValue(link.Id),
                            linkInstanceName = linkName,
                            sourceDocumentTitle = title,
                            sourceDocumentPath = path,
                            transform = BuildTransformPayload(transform)
                        },
                        boundaryLoops = boundary.boundaryLoops,
                        boundarySegments = req.includeBoundarySegmentMetadata ? boundary.boundarySegments : null,
                        warnings = roomWarnings
                    });
                }

                linksSearched.Add(new
                {
                    linkInstanceId = ElementIdCompat.GetValue(link.Id),
                    name = linkName,
                    documentTitle = title,
                    documentPath = path,
                    roomsMatched = linkRoomCount,
                    roomsWithBoundaries = linkBoundaryCount
                });

                if (rooms.Count >= maxRooms)
                {
                    warnings.Add($"maxRooms limit reached at {maxRooms}.");
                    break;
                }
            }

            return Task.FromResult<object>(new
            {
                ok = true,
                endpoint = "/revit/linked-room-boundaries",
                readOnly = true,
                requestedLevelName = req.levelName,
                linkedModelNameContains = req.linkedModelNameContains,
                linkedRoomsFound = rooms.Count,
                roomsWithBoundaries,
                roomsWithoutBoundaries = rooms.Count - roomsWithBoundaries,
                linkNamesSearched = linksSearched,
                skippedLinks,
                warnings,
                rooms
            });
        }

        private static bool PassesRoomFilters(Room room, Request req)
        {
            if (!string.IsNullOrWhiteSpace(req.levelName) &&
                !MatchesLevel(room.Level?.Name ?? "", req.levelName))
            {
                return false;
            }

            if (!string.IsNullOrWhiteSpace(req.roomNumber) &&
                !string.Equals((room.Number ?? "").Trim(), req.roomNumber.Trim(), StringComparison.OrdinalIgnoreCase))
            {
                return false;
            }

            if (!string.IsNullOrWhiteSpace(req.roomNameContains) &&
                !MatchesContains(room.Name ?? "", req.roomNameContains))
            {
                return false;
            }

            return true;
        }

        private static (List<object> boundaryLoops, List<object> boundarySegments) BuildBoundaryPayload(
            Document linkDoc,
            Room room,
            Transform transform,
            bool includeSegmentMetadata,
            List<string> warnings)
        {
            var boundaryLoops = new List<object>();
            var boundarySegments = new List<object>();
            var options = new SpatialElementBoundaryOptions
            {
                SpatialElementBoundaryLocation = SpatialElementBoundaryLocation.Finish
            };

            try
            {
                var loops = room.GetBoundarySegments(options);
                if (loops == null || loops.Count == 0)
                {
                    warnings.Add("linked_room_boundary_segments_unavailable");
                    return (boundaryLoops, boundarySegments);
                }

                for (var loopIndex = 0; loopIndex < loops.Count; loopIndex++)
                {
                    var loop = loops[loopIndex];
                    if (loop == null || loop.Count == 0) continue;
                    var points = new List<object>();
                    for (var segmentIndex = 0; segmentIndex < loop.Count; segmentIndex++)
                    {
                        var segment = loop[segmentIndex];
                        var curve = segment?.GetCurve();
                        if (curve == null) continue;
                        var hostStart = transform.OfPoint(curve.GetEndPoint(0));
                        var hostEnd = transform.OfPoint(curve.GetEndPoint(1));
                        points.Add(ToPoint(hostStart));

                        if (includeSegmentMetadata)
                        {
                            var boundaryElement = SafeGetElement(linkDoc, segment!.ElementId);
                            boundarySegments.Add(new
                            {
                                loopIndex,
                                segmentIndex,
                                linkedBoundaryElementId = ElementIdCompat.GetValue(segment.ElementId),
                                linkedBoundaryElementUniqueId = boundaryElement?.UniqueId,
                                linkedBoundaryElementCategory = boundaryElement?.Category?.Name,
                                linkedBoundaryElementName = boundaryElement?.Name,
                                hostStart = ToPoint(hostStart),
                                hostEnd = ToPoint(hostEnd),
                                lengthFt = curve.Length
                            });
                        }
                    }

                    if (points.Count >= 3)
                    {
                        boundaryLoops.Add(points);
                    }
                }
            }
            catch (Exception ex)
            {
                warnings.Add($"linked_room_boundary_read_failed: {ex.Message}");
            }

            if (boundaryLoops.Count == 0 && warnings.Count == 0)
            {
                warnings.Add("linked_room_boundary_empty_after_curve_export");
            }

            return (boundaryLoops, boundarySegments);
        }

        private static bool MatchesContains(string? value, string? filter)
        {
            if (string.IsNullOrWhiteSpace(filter)) return true;
            return (value ?? "").IndexOf(filter.Trim(), StringComparison.OrdinalIgnoreCase) >= 0;
        }

        private static bool MatchesLevel(string levelName, string requested)
        {
            var a = NormalizeLevel(levelName);
            var b = NormalizeLevel(requested);
            return a.Equals(b, StringComparison.OrdinalIgnoreCase) ||
                   a.IndexOf(b, StringComparison.OrdinalIgnoreCase) >= 0 ||
                   b.IndexOf(a, StringComparison.OrdinalIgnoreCase) >= 0;
        }

        private static string NormalizeLevel(string value)
        {
            return (value ?? "")
                .Trim()
                .Replace(" ", "")
                .Replace("-", "")
                .Replace("_", "")
                .ToUpperInvariant();
        }

        private static Transform GetLinkTransform(RevitLinkInstance link)
        {
            try { return link.GetTotalTransform(); } catch { }
            try { return link.GetTransform(); } catch { }
            return Transform.Identity;
        }

        private static object? BuildLocation(Room room, Transform transform)
        {
            if (room.Location is LocationPoint lp)
            {
                return ToPoint(transform.OfPoint(lp.Point));
            }
            return null;
        }

        private static object BuildTransformPayload(Transform transform)
        {
            return new
            {
                basisX = new[] { transform.BasisX.X, transform.BasisX.Y, transform.BasisX.Z },
                basisY = new[] { transform.BasisY.X, transform.BasisY.Y, transform.BasisY.Z },
                basisZ = new[] { transform.BasisZ.X, transform.BasisZ.Y, transform.BasisZ.Z },
                origin = new[] { transform.Origin.X, transform.Origin.Y, transform.Origin.Z }
            };
        }

        private static object ToPoint(XYZ point) => new { x = point.X, y = point.Y, z = point.Z };

        private static Element? SafeGetElement(Document doc, ElementId id)
        {
            try { return doc.GetElement(id); } catch { return null; }
        }

        private static string? SafeDocumentPath(Document? doc)
        {
            if (doc == null) return null;
            try { return doc.PathName; } catch { return null; }
        }

        private static double? SafeArea(Room room)
        {
            try { return room.Area; } catch { return null; }
        }

        private static double? SafeVolume(Room room)
        {
            try { return room.Volume; } catch { return null; }
        }
    }
}
