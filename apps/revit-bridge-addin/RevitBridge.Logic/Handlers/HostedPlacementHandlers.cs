using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Reflection;
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Threading.Tasks;
using Autodesk.Revit.DB;
using Autodesk.Revit.DB.Architecture;
using Autodesk.Revit.DB.Electrical;
using Autodesk.Revit.DB.Mechanical;
using Autodesk.Revit.DB.Structure;
using Autodesk.Revit.UI;
using RevitBridge.Common;
using RevitBridge.Common.Electrical;
using RevitBridge.Common.Spatial;
using RevitBridge.Logic.Handlers.Core;

namespace RevitBridge.Logic.Handlers
{
    internal sealed class FlexibleXyzArrayConverter : JsonConverter<double[]?>
    {
        public override double[]? Read(ref Utf8JsonReader reader, Type typeToConvert, JsonSerializerOptions options)
        {
            if (reader.TokenType == JsonTokenType.Null) return null;

            using var doc = JsonDocument.ParseValue(ref reader);
            var root = doc.RootElement;
            if (root.ValueKind == JsonValueKind.Array)
            {
                var values = root.EnumerateArray()
                    .Select(x => x.ValueKind == JsonValueKind.Number && x.TryGetDouble(out var value) ? (double?)value : null)
                    .Where(x => x.HasValue)
                    .Select(x => x!.Value)
                    .ToArray();
                return values.Length >= 3 ? values : null;
            }

            if (root.ValueKind == JsonValueKind.Object &&
                TryGetDouble(root, "x", out var x) &&
                TryGetDouble(root, "y", out var y) &&
                TryGetDouble(root, "z", out var z))
            {
                return new[] { x, y, z };
            }

            return null;
        }

        public override void Write(Utf8JsonWriter writer, double[]? value, JsonSerializerOptions options)
        {
            if (value == null)
            {
                writer.WriteNullValue();
                return;
            }

            writer.WriteStartArray();
            foreach (var item in value) writer.WriteNumberValue(item);
            writer.WriteEndArray();
        }

        private static bool TryGetDouble(JsonElement root, string name, out double value)
        {
            value = 0;
            if (!root.TryGetProperty(name, out var property) || property.ValueKind != JsonValueKind.Number)
                return false;
            return property.TryGetDouble(out value);
        }
    }

    internal sealed class RoomWallResolution
    {
        public long hostElementId { get; set; }
        public long boundaryElementId { get; set; }
        public long? linkedElementId { get; set; }
        public Element? hostElement { get; set; }
        public Element? boundaryElement { get; set; }
        public Wall? wall { get; set; }
        public double boundaryLengthFt { get; set; }
        public XYZ? midpoint { get; set; }
        public XYZ? tangent { get; set; }
        public XYZ? projectedRoomPoint { get; set; }
        public XYZ? faceSidePreferencePoint { get; set; }
        public XYZ? interiorDirection { get; set; }
        public bool supportsPlacement { get; set; }
        public List<RoomWallSegmentGeometry> geometrySegments { get; set; } = new List<RoomWallSegmentGeometry>();
        public List<object> segments { get; set; } = new List<object>();
    }

    internal sealed class RoomWallSegmentGeometry
    {
        public XYZ start { get; set; } = XYZ.Zero;
        public XYZ end { get; set; } = XYZ.Zero;
        public XYZ midpoint { get; set; } = XYZ.Zero;
        public XYZ direction { get; set; } = XYZ.Zero;
        public double lengthFt { get; set; }
    }

    internal sealed class NearbyHostCandidate
    {
        public Element element { get; set; } = null!;
        public double distanceFt { get; set; }
        public bool onRequestedRoomSide { get; set; }
        public bool supportsPlacement { get; set; }
        public XYZ? point { get; set; }
        public XYZ? projectedPointOnHost { get; set; }
        public XYZ? hostTangent { get; set; }
        public double? hostOffsetFt { get; set; }
    }

    internal sealed class ResolvedSpatialContext
    {
        public SpatialElement element { get; set; } = null!;
        public long id { get; set; }
        public string number { get; set; } = "";
        public string name { get; set; } = "";
        public string kind { get; set; } = "";
        public double confidence { get; set; }
        public string matchMode { get; set; } = "";
    }

    internal sealed class PlacementPreviewLabel
    {
        public string text { get; set; } = "";
        public XYZ point { get; set; } = XYZ.Zero;
        public string? secondaryText { get; set; }
        public XYZ? direction { get; set; }
        public double? directionLengthFt { get; set; }
    }

    internal sealed class HostLocalFrameData
    {
        public string basis { get; set; } = "";
        public long hostElementId { get; set; }
        public long boundaryElementId { get; set; }
        public long? linkedElementId { get; set; }
        public XYZ projectedPoint { get; set; } = XYZ.Zero;
        public XYZ tangent { get; set; } = XYZ.BasisX;
        public XYZ? interiorDirection { get; set; }
        public double curveLengthFt { get; set; }
        public double offsetFromCurveFt { get; set; }
        public double chainageFt { get; set; }
        public double normalizedChainage { get; set; }
        public bool supportsPlacement { get; set; }
    }

    internal sealed class FaceHostedPlacementReference
    {
        public Reference faceReference { get; set; } = null!;
        public XYZ placementPoint { get; set; } = XYZ.Zero;
        public XYZ referenceDirection { get; set; } = XYZ.BasisX;
        public string basis { get; set; } = "";
        public long? linkedElementId { get; set; }
        public double faceDistanceFt { get; set; }
    }

    public sealed class ElectricalVoltageDefinitionRequest
    {
        public string? name { get; set; }
        public double actualValue { get; set; }
        public double minValue { get; set; }
        public double maxValue { get; set; }
    }

    public sealed class ElectricalDistributionSystemDefinitionRequest
    {
        public string? name { get; set; }
        public string? electricalPhase { get; set; }
        public string? phaseConfiguration { get; set; }
        public int numWires { get; set; }
        public ElectricalVoltageDefinitionRequest? voltageLineToLine { get; set; }
        public ElectricalVoltageDefinitionRequest? voltageLineToGround { get; set; }
    }

    internal static class HostedPlacementUtil
    {
        internal sealed class PlacementValidationSummary
        {
            public bool valid { get; set; }
            public string? reason { get; set; }
            public List<long> invalidIds { get; set; } = new List<long>();
            public List<long> offRoomIds { get; set; } = new List<long>();
            public List<long> offWallIds { get; set; } = new List<long>();
            public List<long> unsupportedIds { get; set; } = new List<long>();
            public List<long> missingIds { get; set; } = new List<long>();
            public object? audit { get; set; }
        }

        internal static PlacementValidationSummary ValidateCreatedPlacements(
            UIApplication app,
            IReadOnlyList<long> elementIds,
            long? roomId,
            string? roomNumber,
            string? roomSide,
            List<string> warnings)
        {
            var ids = elementIds.Where(id => id > 0).Distinct().ToList();
            if (ids.Count == 0)
            {
                return new PlacementValidationSummary
                {
                    valid = false,
                    reason = "No created element ids were available for placement validation."
                };
            }

            try
            {
                var result = new AuditHostedInstancePlacementHandler().Handle(app, JsonSerializer.Serialize(new AuditHostedInstancePlacementHandler.Params
                {
                    elementIds = ids,
                    roomId = roomId,
                    roomNumber = roomNumber,
                    roomSide = roomSide,
                    hostCategories = new List<string> { "OST_Walls" },
                    hostSearchRadiusFt = 12.0,
                    maxNearbyHosts = 5
                })).Result;

                using var docJson = JsonDocument.Parse(JsonSerializer.Serialize(result));
                var root = docJson.RootElement;
                var invalidIds = ReadLongArray(root, "invalidIds");
                var offRoomIds = ReadLongArray(root, "offRoomIds");
                var offWallIds = ReadLongArray(root, "offWallIds");
                var unsupportedIds = ReadLongArray(root, "unsupportedIds");
                var missingIds = ReadLongArray(root, "missingIds");
                var valid = invalidIds.Count == 0 && missingIds.Count == 0;
                var reason = valid
                    ? null
                    : $"invalidIds=[{string.Join(",", invalidIds)}], offRoomIds=[{string.Join(",", offRoomIds)}], offWallIds=[{string.Join(",", offWallIds)}], unsupportedIds=[{string.Join(",", unsupportedIds)}], missingIds=[{string.Join(",", missingIds)}]";
                if (!valid) warnings.Add($"Placement validation failed: {reason}");
                return new PlacementValidationSummary
                {
                    valid = valid,
                    reason = reason,
                    invalidIds = invalidIds,
                    offRoomIds = offRoomIds,
                    offWallIds = offWallIds,
                    unsupportedIds = unsupportedIds,
                    missingIds = missingIds,
                    audit = JsonSerializer.Deserialize<object>(root.GetRawText())
                };
            }
            catch (Exception ex)
            {
                warnings.Add($"Placement validation errored: {ex.Message}");
                return new PlacementValidationSummary
                {
                    valid = false,
                    reason = $"Placement validation errored: {ex.Message}"
                };
            }
        }

        private static List<long> ReadLongArray(JsonElement root, string name)
        {
            var values = new List<long>();
            if (!root.TryGetProperty(name, out var array) || array.ValueKind != JsonValueKind.Array) return values;
            foreach (var item in array.EnumerateArray())
            {
                if (item.TryGetInt64(out var value)) values.Add(value);
            }
            return values;
        }

        internal static XYZ? TryGetElementPoint(Element? e)
        {
            if (e == null) return null;
            try
            {
                if (e.Location is LocationPoint lp && lp.Point != null) return lp.Point;
            }
            catch { }

            try
            {
                if (e.Location is LocationCurve lc && lc.Curve != null) return lc.Curve.Evaluate(0.5, true);
            }
            catch { }

            try
            {
                var bb = e.get_BoundingBox(null);
                if (bb != null) return (bb.Min + bb.Max) * 0.5;
            }
            catch { }

            return null;
        }

        internal static View? ResolveView(Document doc, View? activeView, long? viewId)
        {
            if (viewId.HasValue && viewId.Value > 0)
                return doc.GetElement(ElementIdCompat.Create(viewId.Value)) as View;
            return activeView;
        }

        internal static Level? ResolveLevel(Document doc, string? levelName, Element? exemplar = null, Element? host = null)
        {
            var name = (levelName ?? "").Trim();
            if (name.Length > 0)
            {
                return new FilteredElementCollector(doc)
                    .OfClass(typeof(Level))
                    .Cast<Level>()
                    .FirstOrDefault(x => string.Equals((x.Name ?? "").Trim(), name, StringComparison.OrdinalIgnoreCase));
            }

            var ids = new List<ElementId>();
            if (exemplar != null)
            {
                try
                {
                    if (exemplar.LevelId != null && exemplar.LevelId != ElementId.InvalidElementId) ids.Add(exemplar.LevelId);
                }
                catch { }
                var p = exemplar.get_Parameter(BuiltInParameter.FAMILY_LEVEL_PARAM) ?? exemplar.get_Parameter(BuiltInParameter.INSTANCE_REFERENCE_LEVEL_PARAM);
                if (p != null && p.StorageType == StorageType.ElementId)
                {
                    try { ids.Add(p.AsElementId()); } catch { }
                }
                foreach (var paramName in new[] { "Schedule Level", "Level", "Reference Level" })
                {
                    try
                    {
                        var named = exemplar.LookupParameter(paramName);
                        if (named != null && named.StorageType == StorageType.ElementId)
                        {
                            ids.Add(named.AsElementId());
                        }
                    }
                    catch { }
                }
            }

            if (host != null)
            {
                try
                {
                    if (host.LevelId != null && host.LevelId != ElementId.InvalidElementId) ids.Add(host.LevelId);
                }
                catch { }
            }

            foreach (var id in ids.Where(x => x != null && x != ElementId.InvalidElementId))
            {
                var lvl = doc.GetElement(id) as Level;
                if (lvl != null) return lvl;
            }

            return new FilteredElementCollector(doc)
                .OfClass(typeof(Level))
                .Cast<Level>()
                .OrderBy(x => x.Elevation)
                .FirstOrDefault();
        }

        internal static bool IsSupportedPlacementHost(Element? host)
        {
            return host is Wall || host is RevitLinkInstance;
        }

        internal static Element ResolveSupportedPlacementHost(
            Document doc,
            View view,
            Element? requestedHost,
            Element? exemplarOrReference,
            long? roomId,
            string? roomNumber,
            string? roomSide,
            List<string> warnings,
            string operationLabel)
        {
            if (requestedHost != null && IsSupportedPlacementHost(requestedHost))
                return requestedHost;

            var requestedHostLabel = requestedHost?.Category?.Name ?? requestedHost?.GetType().Name ?? "unknown";
            var spatial = FindSpatialElement(doc, roomId, roomNumber);
            var normalizedSide = NormalizeWallSide(roomSide);
            var exemplarHost = (exemplarOrReference as FamilyInstance)?.Host;

            if (exemplarHost != null && IsSupportedPlacementHost(exemplarHost))
            {
                if (spatial?.element == null || string.IsNullOrWhiteSpace(normalizedSide))
                {
                    warnings.Add($"Requested host {requestedHostLabel} is not placeable for {operationLabel}; using the exemplar/reference host {exemplarHost.Category?.Name ?? exemplarHost.GetType().Name} ({ElementIdCompat.GetValue(exemplarHost.Id)}).");
                    return exemplarHost;
                }

                var roomWallsForSide = ResolveRoomWalls(doc, spatial.element, view, normalizedSide, 8);
                var exemplarHostId = ElementIdCompat.GetValue(exemplarHost.Id);
                if (roomWallsForSide.Any(x => x.hostElementId == exemplarHostId))
                {
                    warnings.Add($"Requested host {requestedHostLabel} is not placeable for {operationLabel}; using the exemplar/reference host on the requested room side ({exemplarHostId}).");
                    return exemplarHost;
                }
            }

            if (spatial?.element != null && !string.IsNullOrWhiteSpace(normalizedSide))
            {
                var roomWall = ResolveRoomWalls(doc, spatial.element, view, normalizedSide, 8)
                    .FirstOrDefault(x => x.supportsPlacement && x.hostElement != null);
                if (roomWall?.hostElement != null)
                {
                    warnings.Add($"Requested host {requestedHostLabel} is not placeable for {operationLabel}; falling back to the resolved {normalizedSide} wall host ({roomWall.hostElementId}).");
                    return roomWall.hostElement;
                }
            }

            var searchPoint = TryGetElementPoint(exemplarOrReference) ?? TryGetElementPoint(requestedHost);
            if (searchPoint != null)
            {
                var nearby = FindNearbyHosts(
                    doc,
                    view,
                    searchPoint,
                    new List<string> { "OST_Walls" },
                    12.0,
                    spatial?.element,
                    normalizedSide,
                    8
                );
                var supportedNearby = nearby.FirstOrDefault(x => x.onRequestedRoomSide && x.supportsPlacement)
                    ?? nearby.FirstOrDefault(x => x.supportsPlacement);
                if (supportedNearby?.element != null)
                {
                    warnings.Add($"Requested host {requestedHostLabel} is not placeable for {operationLabel}; using nearby supported wall host {ElementIdCompat.GetValue(supportedNearby.element.Id)} instead.");
                    return supportedNearby.element;
                }
            }

            throw new InvalidOperationException($"Unsupported host element for {operationLabel}: {requestedHostLabel}. No supported wall or exemplar host fallback could be resolved.");
        }

        internal static string NormalizeNumericRoomNumber(string? raw)
        {
            var text = (raw ?? "").Trim();
            if (text.Length == 0) return "";
            for (var i = 0; i < text.Length; i++)
            {
                if (!char.IsDigit(text[i])) return text.ToUpperInvariant();
            }
            var trimmed = text.TrimStart('0');
            return (trimmed.Length == 0 ? "0" : trimmed).ToUpperInvariant();
        }

        internal static string? GetSpatialNumber(SpatialElement? spatial)
        {
            return spatial switch
            {
                Room room => room.Number,
                Space space => space.Number,
                _ => null
            };
        }

        internal static string? GetSpatialName(SpatialElement? spatial)
        {
            return spatial switch
            {
                Room room => room.Name,
                Space space => space.Name,
                _ => spatial?.Name
            };
        }

        internal static string GetSpatialKind(SpatialElement? spatial)
        {
            return spatial switch
            {
                Room => "Room",
                Space => "Space",
                null => "",
                _ => "SpatialElement"
            };
        }

        internal static ResolvedSpatialContext? FindSpatialElement(Document doc, long? spatialId, string? roomNumber, string? spatialKindPreference = "auto")
        {
            if (spatialId.HasValue && spatialId.Value > 0)
            {
                var byId = doc.GetElement(ElementIdCompat.Create(spatialId.Value)) as SpatialElement;
                if (byId != null)
                {
                    return new ResolvedSpatialContext
                    {
                        element = byId,
                        id = ElementIdCompat.GetValue(byId.Id),
                        number = GetSpatialNumber(byId) ?? "",
                        name = GetSpatialName(byId) ?? "",
                        kind = GetSpatialKind(byId),
                        confidence = 1.0,
                        matchMode = "id"
                    };
                }
            }

            var resolved = SpatialElementResolver.ResolveByNumber(doc, roomNumber ?? "", spatialKindPreference);
            if (resolved?.Element == null) return null;
            return new ResolvedSpatialContext
            {
                element = resolved.Element,
                id = ElementIdCompat.GetValue(resolved.Element.Id),
                number = resolved.Number ?? GetSpatialNumber(resolved.Element) ?? "",
                name = GetSpatialName(resolved.Element) ?? "",
                kind = string.IsNullOrWhiteSpace(resolved.SpatialKind) ? GetSpatialKind(resolved.Element) : resolved.SpatialKind,
                confidence = resolved.Confidence,
                matchMode = resolved.MatchMode ?? ""
            };
        }

        internal static Room? FindRoom(Document doc, long? roomId, string? roomNumber)
        {
            return FindSpatialElement(doc, roomId, roomNumber)?.element as Room;
        }

        internal static string NormalizeWallSide(string? raw)
        {
            var value = (raw ?? "").Trim().ToLowerInvariant();
            return value switch
            {
                "west" => "left",
                "left" => "left",
                "east" => "right",
                "right" => "right",
                "north" => "top",
                "top" => "top",
                "upper" => "top",
                "south" => "bottom",
                "bottom" => "bottom",
                "lower" => "bottom",
                _ => value
            };
        }

        internal static void TryGetTypeInfo(Document doc, Element e, out long? typeId, out string? typeName, out string? familyName)
        {
            typeId = null;
            typeName = null;
            familyName = null;
            try
            {
                var id = e.GetTypeId();
                if (id == ElementId.InvalidElementId) return;
                var type = doc.GetElement(id) as ElementType;
                if (type == null) return;
                typeId = ElementIdCompat.GetValue(id);
                typeName = type.Name;
                familyName = type is FamilySymbol fs ? fs.FamilyName : type.FamilyName;
            }
            catch { }
        }

        internal static FamilySymbol? ResolveFamilySymbol(Document doc, long? familySymbolId, string? familyName, string? symbolName, Element? sourceElement)
        {
            if (familySymbolId.HasValue && familySymbolId.Value > 0)
            {
                var byId = doc.GetElement(ElementIdCompat.Create(familySymbolId.Value)) as FamilySymbol;
                if (byId != null) return byId;
            }

            if (sourceElement != null)
            {
                try
                {
                    var type = doc.GetElement(sourceElement.GetTypeId()) as FamilySymbol;
                    if (type != null) return type;
                }
                catch { }
            }

            var family = (familyName ?? "").Trim();
            var symbol = (symbolName ?? "").Trim();
            if (symbol.Length == 0) return null;

            return new FilteredElementCollector(doc)
                .OfClass(typeof(FamilySymbol))
                .Cast<FamilySymbol>()
                .FirstOrDefault(x =>
                    (family.Length == 0 || string.Equals((x.FamilyName ?? "").Trim(), family, StringComparison.OrdinalIgnoreCase)) &&
                    string.Equals((x.Name ?? "").Trim(), symbol, StringComparison.OrdinalIgnoreCase));
        }

        internal static object? BuildVector(XYZ? xyz)
        {
            if (xyz == null) return null;
            return new { x = xyz.X, y = xyz.Y, z = xyz.Z };
        }

        internal static object? BuildPlacementHostPayload(Element? host)
        {
            if (host == null) return null;
            var linkHost = host as RevitLinkInstance;
            var linkDoc = linkHost?.GetLinkDocument();
            return new
            {
                id = ElementIdCompat.GetValue(host.Id),
                category = host.Category?.Name,
                builtInCategory = host.Category?.BuiltInCategory.ToString(),
                name = host.Name,
                linkInstanceId = linkHost == null ? (long?)null : ElementIdCompat.GetValue(linkHost.Id),
                linkInstanceName = linkHost?.Name,
                linkDocumentTitle = linkDoc?.Title
            };
        }

        internal static object? BuildLinkHostPayload(Element? host)
        {
            var linkHost = host as RevitLinkInstance;
            if (linkHost == null) return null;
            var linkDoc = linkHost.GetLinkDocument();
            return new
            {
                linkInstanceId = ElementIdCompat.GetValue(linkHost.Id),
                linkInstanceName = linkHost.Name,
                linkDocumentTitle = linkDoc?.Title
            };
        }

        internal static object? BuildResolvedLinkHostPayload(RoomWallResolution? wall)
        {
            var linkHost = wall?.hostElement as RevitLinkInstance;
            if (linkHost == null) return null;
            var linkDoc = linkHost.GetLinkDocument();
            return new
            {
                linkInstanceId = ElementIdCompat.GetValue(linkHost.Id),
                linkInstanceName = linkHost.Name,
                linkDocumentTitle = linkDoc?.Title,
                linkedElementId = wall?.linkedElementId,
                linkedElementUniqueId = wall?.boundaryElement?.UniqueId,
                linkedElementCategory = wall?.boundaryElement?.Category?.Name,
                linkedElementBuiltInCategory = wall?.boundaryElement?.Category?.BuiltInCategory.ToString(),
                linkedElementName = wall?.boundaryElement?.Name
            };
        }

        internal static object? BuildRoomWallPlacementPayload(RoomWallResolution? wall)
        {
            if (wall == null) return null;
            var frame = BuildHostLocalFrameData(wall.hostElement, wall, wall.projectedRoomPoint ?? wall.midpoint);
            if (frame == null) return null;
            return BuildHostLocalFramePayload(frame);
        }

        internal static object? BuildRoomWallHostContextPayload(RoomWallResolution? wall)
        {
            if (wall == null) return null;
            var linkHost = wall.hostElement as RevitLinkInstance;
            var linkDoc = linkHost?.GetLinkDocument();
            return new
            {
                hostKind = linkHost != null ? "linked_host" : wall.hostElement is Wall ? "wall_host" : "room_boundary",
                hostElementId = wall.hostElementId,
                boundaryElementId = wall.boundaryElementId > 0 ? wall.boundaryElementId : wall.hostElementId,
                linkInstanceId = linkHost == null ? (long?)null : ElementIdCompat.GetValue(linkHost.Id),
                linkedElementId = wall.linkedElementId,
                linkedDocumentTitle = linkDoc?.Title,
                linkedElementUniqueId = wall.boundaryElement?.UniqueId,
                linkedElementCategory = wall.boundaryElement?.Category?.Name,
                linkedElementBuiltInCategory = wall.boundaryElement?.Category?.BuiltInCategory.ToString(),
                linkedElementName = wall.boundaryElement?.Name,
                projectedPoint = BuildVector(wall.projectedRoomPoint),
                tangent = BuildVector(wall.tangent),
                interiorDirection = BuildVector(wall.interiorDirection),
                curveLengthFt = wall.boundaryLengthFt,
                geometrySegments = wall.geometrySegments?.Select(segment => new
                {
                    start = BuildVector(segment.start),
                    end = BuildVector(segment.end),
                    midpoint = BuildVector(segment.midpoint),
                    direction = BuildVector(segment.direction),
                    lengthFt = segment.lengthFt
                }).ToList(),
                supportsPlacement = wall.supportsPlacement,
                requiresExplicitPointXyz = linkHost != null
            };
        }

        internal static RoomWallResolution? ResolveRoomWallForHost(Document doc, View view, Element? host, long? roomId, string? roomNumber, string? roomSide)
        {
            if (doc == null || view == null || host == null) return null;
            var normalizedSide = NormalizeWallSide(roomSide);
            if (normalizedSide != "left" && normalizedSide != "right" && normalizedSide != "top" && normalizedSide != "bottom")
                return null;
            var spatial = FindSpatialElement(doc, roomId, roomNumber);
            if (spatial?.element == null) return null;
            var walls = ResolveRoomWalls(doc, spatial.element, view, normalizedSide, 8);
            if (walls.Count == 0) return null;
            var hostId = ElementIdCompat.GetValue(host.Id);
            return walls.FirstOrDefault(x => x.hostElementId == hostId) ?? walls.FirstOrDefault();
        }

        internal static Element? ResolveFamilyInstanceHost(Document doc, FamilyInstance? instance)
        {
            if (instance == null) return null;
            try
            {
                if (instance.Host != null) return instance.Host;
            }
            catch { }

            try
            {
                var hostFace = instance.HostFace;
                if (hostFace != null && hostFace.ElementId != ElementId.InvalidElementId)
                    return doc.GetElement(hostFace.ElementId);
            }
            catch { }
            return null;
        }

        internal static RoomWallResolution? ResolveLinkedFaceHostFallback(Document doc, Element? host, FamilyInstance? sourceInstance)
        {
            if (host is not RevitLinkInstance link || sourceInstance == null) return null;
            Reference? hostFace;
            try { hostFace = sourceInstance.HostFace; } catch { hostFace = null; }
            if (hostFace == null || hostFace.ElementId != link.Id || hostFace.LinkedElementId == ElementId.InvalidElementId) return null;

            var linkedElement = link.GetLinkDocument()?.GetElement(hostFace.LinkedElementId);
            if (linkedElement == null) return null;
            var point = TryGetElementPoint(sourceInstance) ?? XYZ.Zero;
            XYZ tangent;
            try { tangent = sourceInstance.HandOrientation; } catch { tangent = XYZ.BasisX; }
            if (tangent == null || tangent.GetLength() <= 1e-9) tangent = XYZ.BasisX;
            else tangent = tangent.Normalize();

            return new RoomWallResolution
            {
                hostElementId = ElementIdCompat.GetValue(link.Id),
                boundaryElementId = ElementIdCompat.GetValue(hostFace.LinkedElementId),
                linkedElementId = ElementIdCompat.GetValue(hostFace.LinkedElementId),
                hostElement = link,
                boundaryElement = linkedElement,
                midpoint = point,
                projectedRoomPoint = point,
                tangent = tangent,
                boundaryLengthFt = 0.0,
                supportsPlacement = true
            };
        }

        internal static RoomWallResolution? ResolveExplicitLinkedWallHost(
            RevitLinkInstance link,
            long linkedElementId,
            XYZ worldPoint,
            List<string> warnings)
        {
            if (link == null || linkedElementId <= 0) return null;
            var linkDoc = link.GetLinkDocument();
            if (linkDoc == null)
            {
                warnings.Add($"Explicit linked wall {linkedElementId} could not be resolved because link {ElementIdCompat.GetValue(link.Id)} is unloaded.");
                return null;
            }

            var linkedElement = linkDoc.GetElement(ElementIdCompat.Create(linkedElementId));
            if (linkedElement is not Wall linkedWall || linkedWall.Location is not LocationCurve locationCurve)
            {
                warnings.Add($"Explicit linked host element {linkedElementId} is missing or is not a curve-based Wall.");
                return null;
            }

            Transform transform;
            try { transform = link.GetTotalTransform(); }
            catch { transform = link.GetTransform(); }
            var tessellated = locationCurve.Curve.Tessellate().Select(transform.OfPoint).ToList();
            if (tessellated.Count < 2)
            {
                warnings.Add($"Explicit linked wall {linkedElementId} did not expose enough curve geometry for placement.");
                return null;
            }

            var geometrySegments = new List<RoomWallSegmentGeometry>();
            for (var index = 0; index < tessellated.Count - 1; index++)
            {
                var start = tessellated[index];
                var end = tessellated[index + 1];
                var delta = end - start;
                var length = delta.GetLength();
                if (length <= 1e-9) continue;
                geometrySegments.Add(new RoomWallSegmentGeometry
                {
                    start = start,
                    end = end,
                    midpoint = (start + end) * 0.5,
                    direction = delta / length,
                    lengthFt = length
                });
            }
            if (geometrySegments.Count == 0)
            {
                warnings.Add($"Explicit linked wall {linkedElementId} produced only zero-length placement geometry.");
                return null;
            }

            var resolution = new RoomWallResolution
            {
                hostElementId = ElementIdCompat.GetValue(link.Id),
                boundaryElementId = linkedElementId,
                linkedElementId = linkedElementId,
                hostElement = link,
                boundaryElement = linkedWall,
                wall = null,
                boundaryLengthFt = geometrySegments.Sum(segment => segment.lengthFt),
                midpoint = new XYZ(
                    geometrySegments.Average(segment => segment.midpoint.X),
                    geometrySegments.Average(segment => segment.midpoint.Y),
                    geometrySegments.Average(segment => segment.midpoint.Z)),
                tangent = geometrySegments.OrderBy(segment => segment.midpoint.DistanceTo(worldPoint)).First().direction,
                supportsPlacement = true,
                geometrySegments = geometrySegments,
                segments = geometrySegments.Select((segment, index) => (object)new
                {
                    segmentIndex = index,
                    hostElementId = ElementIdCompat.GetValue(link.Id),
                    boundaryElementId = linkedElementId,
                    linkedElementId,
                    start = BuildVector(segment.start),
                    end = BuildVector(segment.end),
                    midpoint = BuildVector(segment.midpoint),
                    direction = BuildVector(segment.direction),
                    lengthFt = segment.lengthFt
                }).ToList()
            };
            if (TryProjectPointToRoomWall(resolution, worldPoint, out var projected, out var tangent, out _, out _))
            {
                resolution.projectedRoomPoint = projected;
                resolution.tangent = tangent;
            }
            return resolution;
        }

        internal static string? BuildPlacementPreviewSecondaryText(HostLocalFrameData? frame, Element? orientationElement = null)
        {
            if (frame == null) return null;
            var text = $"chainage {frame.chainageFt:F2}ft ({frame.normalizedChainage:P0})";
            var orientation = TryComputeOrientationRelativeToHostRadians(orientationElement, frame);
            if (orientation.HasValue)
                text += $" | orient {orientation.Value * 180.0 / Math.PI:F0}deg";
            return text;
        }

        internal static object? BuildResolvedSpatialPayload(ResolvedSpatialContext? spatial, string? requestedSide = null)
        {
            if (spatial?.element == null) return null;
            return new
            {
                id = spatial.id,
                number = spatial.number,
                name = spatial.name,
                kind = spatial.kind,
                confidence = spatial.confidence,
                matchMode = spatial.matchMode,
                requestedSide = string.IsNullOrWhiteSpace(requestedSide) ? null : NormalizeWallSide(requestedSide)
            };
        }

        internal static object? BuildOrientationPayload(Element e, RevitLinkInstance? linkInstance = null)
        {
            XYZ? facingVector = null;
            XYZ? handVector = null;
            XYZ? curveDirectionVector = null;
            XYZ? basisXVector = null;
            XYZ? basisYVector = null;
            XYZ? basisZVector = null;
            XYZ? transformOrigin = null;
            double? rotationRadians = null;
            bool? mirrored = null;
            bool? handFlipped = null;
            bool? facingFlipped = null;
            bool? canFlipFacing = null;
            bool? canFlipHand = null;
            bool? workPlaneFlipped = null;
            string? locationKind = null;

            if (e is FamilyInstance fi)
            {
                try { facingVector = TransformVectorToHost(linkInstance, fi.FacingOrientation); } catch { }
                try { handVector = TransformVectorToHost(linkInstance, fi.HandOrientation); } catch { }
                try { mirrored = fi.Mirrored; } catch { }
                try { handFlipped = fi.HandFlipped; } catch { }
                try { facingFlipped = fi.FacingFlipped; } catch { }
                try { canFlipFacing = fi.CanFlipFacing; } catch { }
                try { canFlipHand = fi.CanFlipHand; } catch { }
                try { workPlaneFlipped = fi.IsWorkPlaneFlipped; } catch { }

                var familyTransform = TryGetElementTransform(fi);
                if (familyTransform != null)
                {
                    transformOrigin = TransformPointToHost(linkInstance, familyTransform.Origin);
                    basisXVector = TransformVectorToHost(linkInstance, familyTransform.BasisX);
                    basisYVector = TransformVectorToHost(linkInstance, familyTransform.BasisY);
                    basisZVector = TransformVectorToHost(linkInstance, familyTransform.BasisZ);
                }
            }

            if (basisXVector == null || basisYVector == null || basisZVector == null || transformOrigin == null)
            {
                var elementTransform = TryGetElementTransform(e);
                if (elementTransform != null)
                {
                    if (transformOrigin == null) transformOrigin = TransformPointToHost(linkInstance, elementTransform.Origin);
                    if (basisXVector == null) basisXVector = TransformVectorToHost(linkInstance, elementTransform.BasisX);
                    if (basisYVector == null) basisYVector = TransformVectorToHost(linkInstance, elementTransform.BasisY);
                    if (basisZVector == null) basisZVector = TransformVectorToHost(linkInstance, elementTransform.BasisZ);
                }
            }

            try
            {
                if (e.Location is LocationPoint lp)
                {
                    locationKind = "point";
                    rotationRadians = lp.Rotation;
                }
                else if (e.Location is LocationCurve lc && lc.Curve != null)
                {
                    locationKind = "curve";
                    var start = TransformPointToHost(linkInstance, lc.Curve.GetEndPoint(0));
                    var end = TransformPointToHost(linkInstance, lc.Curve.GetEndPoint(1));
                    var direction = end - start;
                    if (direction.GetLength() > 1e-9) curveDirectionVector = direction.Normalize();
                }
            }
            catch { }

            var planAzimuthRadians = TryComputePlanAzimuthRadians(facingVector);
            var planAzimuthSource = planAzimuthRadians.HasValue ? "facing" : (string?)null;

            if (!planAzimuthRadians.HasValue)
            {
                planAzimuthRadians = TryComputePlanAzimuthRadians(curveDirectionVector);
                if (planAzimuthRadians.HasValue) planAzimuthSource = "curveDirection";
            }

            if (!planAzimuthRadians.HasValue)
            {
                planAzimuthRadians = TryComputePlanAzimuthRadians(basisXVector);
                if (planAzimuthRadians.HasValue) planAzimuthSource = "basisX";
            }

            if (!planAzimuthRadians.HasValue && rotationRadians.HasValue)
            {
                if (linkInstance != null)
                {
                    var rotatedBasis = TransformVectorToHost(linkInstance, new XYZ(Math.Cos(rotationRadians.Value), Math.Sin(rotationRadians.Value), 0));
                    planAzimuthRadians = TryComputePlanAzimuthRadians(rotatedBasis);
                    if (planAzimuthRadians.HasValue) planAzimuthSource = "rotationTransformed";
                }

                if (!planAzimuthRadians.HasValue)
                {
                    planAzimuthRadians = NormalizeRadians(rotationRadians.Value);
                    planAzimuthSource = "rotation";
                }
            }

            var rotationDegrees = rotationRadians.HasValue ? rotationRadians.Value * (180.0 / Math.PI) : (double?)null;
            var planAzimuthDegrees = planAzimuthRadians.HasValue ? planAzimuthRadians.Value * (180.0 / Math.PI) : (double?)null;
            var facing = BuildVector(facingVector);
            var hand = BuildVector(handVector);
            var curveDirection = BuildVector(curveDirectionVector);
            var basisX = BuildVector(basisXVector);
            var basisY = BuildVector(basisYVector);
            var basisZ = BuildVector(basisZVector);
            var origin = BuildVector(transformOrigin);

            if (facing == null &&
                hand == null &&
                curveDirection == null &&
                basisX == null &&
                basisY == null &&
                basisZ == null &&
                origin == null &&
                rotationRadians == null &&
                mirrored == null &&
                handFlipped == null &&
                facingFlipped == null &&
                canFlipFacing == null &&
                canFlipHand == null &&
                workPlaneFlipped == null &&
                planAzimuthRadians == null)
            {
                return null;
            }

            return new
            {
                facing,
                hand,
                curveDirection,
                basisX,
                basisY,
                basisZ,
                origin,
                rotationRadians,
                rotationDegrees,
                planAzimuthRadians,
                planAzimuthDegrees,
                planAzimuthSource,
                locationKind,
                mirrored,
                handFlipped,
                facingFlipped,
                canFlipFacing,
                canFlipHand,
                workPlaneFlipped,
                linkTransformed = linkInstance != null
            };
        }

        private static Transform? TryGetElementTransform(Element? element)
        {
            if (element == null) return null;
            if (element is RevitLinkInstance linkInstance)
            {
                try { return linkInstance.GetTotalTransform(); } catch { }
                try { return linkInstance.GetTransform(); } catch { }
                return null;
            }

            if (element is Instance instance)
            {
                try { return instance.GetTransform(); } catch { }
            }

            return null;
        }

        private static XYZ TransformPointToHost(RevitLinkInstance? linkInstance, XYZ point)
        {
            if (linkInstance == null) return point;
            try { return linkInstance.GetTotalTransform().OfPoint(point); } catch { }
            try { return linkInstance.GetTransform().OfPoint(point); } catch { }
            return point;
        }

        private static XYZ TransformVectorToHost(RevitLinkInstance? linkInstance, XYZ vector)
        {
            if (linkInstance == null) return vector;
            try { return linkInstance.GetTotalTransform().OfVector(vector); } catch { }
            try { return linkInstance.GetTransform().OfVector(vector); } catch { }
            return vector;
        }

        private static double? TryComputePlanAzimuthRadians(XYZ? vector)
        {
            if (vector == null) return null;
            var x = vector.X;
            var y = vector.Y;
            if (Math.Abs(x) < 1e-9 && Math.Abs(y) < 1e-9) return null;
            return NormalizeRadians(Math.Atan2(y, x));
        }

        internal static double NormalizeRadians(double value)
        {
            if (double.IsNaN(value) || double.IsInfinity(value)) return 0.0;
            var angle = value;
            while (angle <= -Math.PI) angle += Math.PI * 2.0;
            while (angle > Math.PI) angle -= Math.PI * 2.0;
            return angle;
        }

        internal static double? TryGetLocationRotationRadians(Element? e)
        {
            if (e == null) return null;
            try
            {
                if (e.Location is LocationPoint lp) return lp.Rotation;
            }
            catch { }
            return null;
        }

        internal static double? TryComputeOrientationRelativeToHostRadians(Element? e, HostLocalFrameData? frame)
        {
            if (e == null || frame == null) return null;
            XYZ? facing = null;
            try { facing = (e as FamilyInstance)?.FacingOrientation; } catch { facing = null; }
            if (facing != null && facing.GetLength() > 1e-9)
            {
                var tangent = frame.tangent.GetLength() > 1e-9 ? frame.tangent.Normalize() : XYZ.BasisX;
                var interior = frame.interiorDirection != null && frame.interiorDirection.GetLength() > 1e-9
                    ? frame.interiorDirection.Normalize()
                    : XYZ.BasisY;
                var x = facing.DotProduct(tangent);
                var y = facing.DotProduct(interior);
                return NormalizeRadians(Math.Atan2(y, x));
            }

            var rotation = TryGetLocationRotationRadians(e);
            return rotation.HasValue ? NormalizeRadians(rotation.Value) : (double?)null;
        }

        internal static bool TryProjectPointToWallDetailed(
            Wall wall,
            XYZ point,
            out XYZ projectedPoint,
            out XYZ tangent,
            out double curveLengthFt,
            out double offsetFt,
            out double chainageFt,
            out double normalizedChainage)
        {
            projectedPoint = XYZ.Zero;
            tangent = XYZ.BasisX;
            curveLengthFt = 0.0;
            offsetFt = 0.0;
            chainageFt = 0.0;
            normalizedChainage = 0.0;

            var curve = (wall.Location as LocationCurve)?.Curve;
            if (curve == null) return false;
            curveLengthFt = Math.Max(0.0, curve.Length);

            IntersectionResult? projection = null;
            try { projection = curve.Project(point); } catch { projection = null; }
            if (projection == null) return false;

            projectedPoint = projection.XYZPoint;
            offsetFt = projection.Distance;

            try
            {
                var deriv = curve.ComputeDerivatives(projection.Parameter, false);
                if (deriv?.BasisX != null && deriv.BasisX.GetLength() > 1e-9)
                    tangent = deriv.BasisX.Normalize();
            }
            catch { }

            if (tangent.GetLength() < 1e-9)
            {
                try
                {
                    var a = curve.GetEndPoint(0);
                    var b = curve.GetEndPoint(1);
                    var dir = b - a;
                    if (dir.GetLength() > 1e-9) tangent = dir.Normalize();
                }
                catch { }
            }

            try
            {
                var startParam = curve.GetEndParameter(0);
                var endParam = curve.GetEndParameter(1);
                if (Math.Abs(endParam - startParam) > 1e-9)
                {
                    var normalized = (projection.Parameter - startParam) / (endParam - startParam);
                    chainageFt = Math.Max(0.0, Math.Min(curveLengthFt, normalized * curveLengthFt));
                }
                else
                {
                    chainageFt = 0.0;
                }
            }
            catch
            {
                try { chainageFt = curve.GetEndPoint(0).DistanceTo(projectedPoint); } catch { chainageFt = 0.0; }
            }
            normalizedChainage = curveLengthFt > 1e-9 ? Math.Max(0.0, Math.Min(1.0, chainageFt / curveLengthFt)) : 0.0;
            return true;
        }

        internal static bool TryProjectPointToRoomWallDetailed(
            RoomWallResolution resolution,
            XYZ point,
            out XYZ projectedPoint,
            out XYZ tangent,
            out double curveLengthFt,
            out double offsetFt,
            out double chainageFt,
            out double normalizedChainage)
        {
            projectedPoint = XYZ.Zero;
            tangent = XYZ.BasisX;
            curveLengthFt = Math.Max(0.0, resolution?.boundaryLengthFt ?? 0.0);
            offsetFt = 0.0;
            chainageFt = 0.0;
            normalizedChainage = 0.0;
            if (resolution == null || resolution.geometrySegments == null || resolution.geometrySegments.Count == 0) return false;

            var bestDistance = double.MaxValue;
            var running = 0.0;
            foreach (var segment in resolution.geometrySegments)
            {
                if (segment == null || segment.lengthFt <= 1e-9)
                {
                    running += Math.Max(0.0, segment?.lengthFt ?? 0.0);
                    continue;
                }

                try
                {
                    var line = Line.CreateBound(segment.start, segment.end);
                    var projection = line.Project(point);
                    if (projection == null)
                    {
                        running += segment.lengthFt;
                        continue;
                    }
                    if (projection.Distance < bestDistance)
                    {
                        bestDistance = projection.Distance;
                        projectedPoint = projection.XYZPoint;
                        tangent = segment.direction.GetLength() > 1e-9 ? segment.direction.Normalize() : tangent;
                        offsetFt = projection.Distance;
                        var segmentChainage = segment.start.DistanceTo(projectedPoint);
                        chainageFt = running + Math.Max(0.0, Math.Min(segment.lengthFt, segmentChainage));
                    }
                }
                catch { }

                running += segment.lengthFt;
            }

            if (bestDistance >= double.MaxValue) return false;
            normalizedChainage = curveLengthFt > 1e-9 ? Math.Max(0.0, Math.Min(1.0, chainageFt / curveLengthFt)) : 0.0;
            return true;
        }

        internal static HostLocalFrameData? BuildHostLocalFrameData(Element? host, RoomWallResolution? roomWall, XYZ? point)
        {
            if (host == null || point == null) return null;

            if (host is Wall wall)
            {
                if (!TryProjectPointToWallDetailed(wall, point, out var projected, out var tangent, out var curveLengthFt, out var offsetFt, out var chainageFt, out var normalizedChainage))
                    return null;
                XYZ? interior = null;
                try
                {
                    var towardPoint = point - projected;
                    if (towardPoint.GetLength() > 1e-9) interior = towardPoint.Normalize();
                }
                catch { }
                return new HostLocalFrameData
                {
                    basis = "wall_host",
                    hostElementId = ElementIdCompat.GetValue(host.Id),
                    boundaryElementId = ElementIdCompat.GetValue(host.Id),
                    projectedPoint = projected,
                    tangent = tangent,
                    interiorDirection = interior,
                    curveLengthFt = curveLengthFt,
                    offsetFromCurveFt = offsetFt,
                    chainageFt = chainageFt,
                    normalizedChainage = normalizedChainage,
                    supportsPlacement = true
                };
            }

            if (host is RevitLinkInstance && roomWall != null)
            {
                if (!TryProjectPointToRoomWallDetailed(roomWall, point, out var projected, out var tangent, out var curveLengthFt, out var offsetFt, out var chainageFt, out var normalizedChainage))
                    return null;
                return new HostLocalFrameData
                {
                    basis = "linked_room_boundary",
                    hostElementId = roomWall.hostElementId,
                    boundaryElementId = roomWall.boundaryElementId > 0 ? roomWall.boundaryElementId : roomWall.hostElementId,
                    linkedElementId = roomWall.linkedElementId,
                    projectedPoint = projected,
                    tangent = tangent,
                    interiorDirection = roomWall.interiorDirection,
                    curveLengthFt = curveLengthFt,
                    offsetFromCurveFt = offsetFt,
                    chainageFt = chainageFt,
                    normalizedChainage = normalizedChainage,
                    supportsPlacement = roomWall.supportsPlacement
                };
            }

            return null;
        }

        internal static XYZ? TryPointAtChainageOnWall(Wall wall, double chainageFt)
        {
            var curve = (wall.Location as LocationCurve)?.Curve;
            if (curve == null) return null;
            var length = Math.Max(0.0, curve.Length);
            if (length <= 1e-9) return null;
            var clamped = Math.Max(0.0, Math.Min(length, chainageFt));
            try
            {
                var startParam = curve.GetEndParameter(0);
                var endParam = curve.GetEndParameter(1);
                var t = clamped / length;
                var param = startParam + ((endParam - startParam) * t);
                return curve.Evaluate(param, false);
            }
            catch
            {
                try { return curve.Evaluate(clamped / length, true); } catch { return null; }
            }
        }

        internal static XYZ? TryPointAtChainageOnRoomWall(RoomWallResolution resolution, double chainageFt)
        {
            if (resolution == null || resolution.geometrySegments == null || resolution.geometrySegments.Count == 0) return null;
            var remaining = Math.Max(0.0, chainageFt);
            foreach (var segment in resolution.geometrySegments)
            {
                if (segment == null || segment.lengthFt <= 1e-9) continue;
                if (remaining <= segment.lengthFt)
                {
                    var dir = segment.direction.GetLength() > 1e-9 ? segment.direction.Normalize() : XYZ.BasisX;
                    return segment.start + dir.Multiply(remaining);
                }
                remaining -= segment.lengthFt;
            }
            var last = resolution.geometrySegments.LastOrDefault(x => x != null);
            return last?.end;
        }

        internal static object? BuildHostLocalFramePayload(HostLocalFrameData? frame, Element? element = null)
        {
            if (frame == null) return null;
            var orientationRelative = element == null ? (double?)null : TryComputeOrientationRelativeToHostRadians(element, frame);
            return new
            {
                basis = frame.basis,
                hostElementId = frame.hostElementId,
                boundaryElementId = frame.boundaryElementId,
                linkedElementId = frame.linkedElementId,
                projectedPoint = BuildVector(frame.projectedPoint),
                tangent = BuildVector(frame.tangent),
                interiorDirection = BuildVector(frame.interiorDirection),
                curveLengthFt = frame.curveLengthFt,
                offsetFromCurveFt = frame.offsetFromCurveFt,
                chainageFt = frame.chainageFt,
                normalizedChainage = frame.normalizedChainage,
                supportsPlacement = frame.supportsPlacement,
                orientationRelativeToHostRadians = orientationRelative,
                orientationRelativeToHostDegrees = orientationRelative.HasValue ? orientationRelative.Value * 180.0 / Math.PI : (double?)null
            };
        }

        internal static bool TryProjectPointToWall(Wall wall, XYZ point, out XYZ projectedPoint, out XYZ tangent, out double curveLengthFt, out double offsetFt)
        {
            return TryProjectPointToWallDetailed(
                wall,
                point,
                out projectedPoint,
                out tangent,
                out curveLengthFt,
                out offsetFt,
                out _,
                out _
            );
        }

        internal static bool TryProjectPointToRoomWall(RoomWallResolution resolution, XYZ point, out XYZ projectedPoint, out XYZ tangent, out double curveLengthFt, out double offsetFt)
        {
            return TryProjectPointToRoomWallDetailed(
                resolution,
                point,
                out projectedPoint,
                out tangent,
                out curveLengthFt,
                out offsetFt,
                out _,
                out _
            );
        }

        internal static XYZ ConvertWorldPointForHost(Element host, XYZ worldPoint)
        {
            if (host is RevitLinkInstance link)
            {
                try
                {
                    return link.GetTotalTransform().Inverse.OfPoint(worldPoint);
                }
                catch
                {
                    try { return link.GetTransform().Inverse.OfPoint(worldPoint); } catch { }
                }
            }

            return worldPoint;
        }

        internal static FaceHostedPlacementReference? TryResolveFaceHostedPlacementReference(
            Element host,
            RoomWallResolution? roomWall,
            XYZ worldPoint,
            XYZ? preferredReferenceDirection,
            List<string> warnings,
            string? sourceStableReferencePattern = null)
        {
            if (host is not RevitLinkInstance link)
            {
                return TryResolveNativeFaceHostedPlacementReference(
                    host,
                    worldPoint,
                    preferredReferenceDirection,
                    warnings
                );
            }
            if (roomWall?.linkedElementId == null || roomWall.linkedElementId.Value <= 0) return null;
            var preferredDirection = preferredReferenceDirection != null && preferredReferenceDirection.GetLength() > 1e-9
                ? preferredReferenceDirection.Normalize()
                : roomWall.tangent != null && roomWall.tangent.GetLength() > 1e-9
                    ? roomWall.tangent.Normalize()
                    : XYZ.BasisX;

            var referenceView = LinkedFaceReferenceUtil.FindReferenceView(host.Document);
            if (referenceView == null)
            {
                warnings.Add("Linked face placement requires a non-template 3D reference view, but none was available.");
                return null;
            }

            if (!LinkedFaceReferenceUtil.TryResolve(
                    host.Document,
                    referenceView,
                    link,
                    ElementIdCompat.Create(roomWall.linkedElementId.Value),
                    worldPoint,
                    preferredDirection,
                    out var resolution,
                    out var error,
                    searchRadiusFt: 4.0,
                    maximumResolvedDisplacementFt: 1.0,
                    maximumVerticalDisplacementFt: 0.5,
                    requireVerticalFace: true,
                    sourceStableReferencePattern: sourceStableReferencePattern,
                    preferredFaceSidePoint: roomWall?.faceSidePreferencePoint) || resolution == null)
            {
                warnings.Add($"Linked face placement could not resolve linked element {roomWall.linkedElementId.Value}: {error}");
                return null;
            }

            return new FaceHostedPlacementReference
            {
                faceReference = resolution.FaceReference,
                placementPoint = resolution.PlacementPoint,
                referenceDirection = resolution.ReferenceDirection,
                basis = "linked_face_reference",
                linkedElementId = roomWall.linkedElementId,
                faceDistanceFt = resolution.DistanceFt
            };
        }

        private static FaceHostedPlacementReference? TryResolveNativeFaceHostedPlacementReference(
            Element host,
            XYZ worldPoint,
            XYZ? preferredReferenceDirection,
            List<string> warnings)
        {
            var referenceView = LinkedFaceReferenceUtil.FindReferenceView(host.Document);
            if (referenceView == null)
            {
                warnings.Add("Native face placement requires a non-template 3D reference view, but none was available.");
                return null;
            }

            var directions = new[]
            {
                XYZ.BasisX, XYZ.BasisX.Negate(),
                XYZ.BasisY, XYZ.BasisY.Negate(),
                XYZ.BasisZ, XYZ.BasisZ.Negate()
            };
            Reference? bestReference = null;
            XYZ? bestPoint = null;
            XYZ? bestNormal = null;
            var bestDistance = double.MaxValue;
            var filter = new ElementIdSetFilter(new List<ElementId> { host.Id });
            var intersector = new ReferenceIntersector(filter, FindReferenceTarget.Face, referenceView)
            {
                FindReferencesInRevitLinks = false
            };

            const double rayOffsetFt = 4.0;
            foreach (var outward in directions)
            {
                var origin = worldPoint + outward.Multiply(rayOffsetFt);
                var hit = intersector.FindNearest(origin, outward.Negate());
                var reference = hit?.GetReference();
                var point = reference?.GlobalPoint;
                if (reference == null || point == null || reference.ElementId != host.Id) continue;
                var distance = point.DistanceTo(worldPoint);
                if (distance > 1.25 || distance >= bestDistance) continue;

                XYZ? normal = null;
                try
                {
                    if (host.GetGeometryObjectFromReference(reference) is Face face)
                    {
                        normal = face.ComputeNormal(reference.UVPoint);
                    }
                }
                catch { }
                if (host is Wall && normal != null && Math.Abs(normal.Normalize().DotProduct(XYZ.BasisZ)) > 0.25)
                    continue;

                bestReference = reference;
                bestPoint = point;
                bestNormal = normal;
                bestDistance = distance;
            }

            if (bestReference == null || bestPoint == null)
            {
                warnings.Add($"Native face placement could not resolve a compatible face on element {ElementIdCompat.GetValue(host.Id)} within 1.25 ft of the requested point.");
                return null;
            }

            var preferred = preferredReferenceDirection != null && preferredReferenceDirection.GetLength() > 1e-9
                ? preferredReferenceDirection.Normalize()
                : XYZ.BasisX;
            var normalVector = bestNormal != null && bestNormal.GetLength() > 1e-9
                ? bestNormal.Normalize()
                : XYZ.BasisZ;
            var referenceDirection = preferred - normalVector.Multiply(preferred.DotProduct(normalVector));
            if (referenceDirection.GetLength() <= 1e-9)
            {
                referenceDirection = XYZ.BasisZ.CrossProduct(normalVector);
                if (referenceDirection.GetLength() <= 1e-9)
                    referenceDirection = XYZ.BasisX.CrossProduct(normalVector);
            }
            referenceDirection = referenceDirection.Normalize();

            return new FaceHostedPlacementReference
            {
                faceReference = bestReference,
                placementPoint = bestPoint,
                referenceDirection = referenceDirection,
                basis = "native_face_reference",
                linkedElementId = null,
                faceDistanceFt = bestDistance
            };
        }

        internal static bool RequiresLinkedFaceHostedPlacement(Element host, RoomWallResolution? roomWall)
        {
            return host is RevitLinkInstance && roomWall?.linkedElementId != null && roomWall.linkedElementId.Value > 0;
        }

        internal static double ViewPlaneDistanceFt(View view, XYZ a, XYZ b)
        {
            var right = view.RightDirection.Normalize();
            var up = view.UpDirection.Normalize();
            var delta = a - b;
            var dx = delta.DotProduct(right);
            var dy = delta.DotProduct(up);
            return Math.Sqrt((dx * dx) + (dy * dy));
        }

        internal static bool TryIsPointInSpatial(SpatialElement? spatial, XYZ point)
        {
            if (spatial == null) return false;
            try
            {
                if (spatial is Room room) return room.IsPointInRoom(point);
                if (spatial is Space space) return space.IsPointInSpace(point);
            }
            catch { }

            return false;
        }

        internal static List<RoomWallResolution> ResolveRoomWalls(Document doc, SpatialElement spatial, View view, string? side, int maxWalls)
        {
            var wantedSide = NormalizeWallSide(side);
            var opts = new SpatialElementBoundaryOptions
            {
                SpatialElementBoundaryLocation = SpatialElementBoundaryLocation.Finish
            };

            var right = view.RightDirection.Normalize();
            var up = view.UpDirection.Normalize();
            var roomPoint = TryGetElementPoint(spatial) ?? XYZ.Zero;
            var rawSegments = new List<(int loopIndex, int segmentIndex, long hostId, long linkedElementId, XYZ start, XYZ end, XYZ midpoint, XYZ direction, double midX, double midY, double lenFt, double dirX, double dirY)>();
            var segmentsList = spatial.GetBoundarySegments(opts);
            if (segmentsList == null) return new List<RoomWallResolution>();

            var loopIndex = 0;
            foreach (var loop in segmentsList)
            {
                var segIndex = 0;
                foreach (var s in loop)
                {
                    var curve = s.GetCurve();
                    var p0 = curve.GetEndPoint(0);
                    var p1 = curve.GetEndPoint(1);
                    var d = p1 - p0;
                    var len = d.GetLength();
                    var dir = len > 1e-9 ? d / len : XYZ.Zero;
                    var mid = (p0 + p1) * 0.5;
                    var hostId = ElementIdCompat.GetValue(s.ElementId);
                    var linkedElementId = ElementIdCompat.GetValue(s.LinkElementId);
                    if (hostId <= 0)
                    {
                        segIndex++;
                        continue;
                    }

                    rawSegments.Add((loopIndex, segIndex, hostId, linkedElementId, p0, p1, mid, dir, mid.DotProduct(right), mid.DotProduct(up), curve.Length, dir.DotProduct(right), dir.DotProduct(up)));
                    segIndex++;
                }
                loopIndex++;
            }

            if (rawSegments.Count == 0) return new List<RoomWallResolution>();

            var minX = rawSegments.Min(x => x.midX);
            var maxX = rawSegments.Max(x => x.midX);
            var minY = rawSegments.Min(x => x.midY);
            var maxY = rawSegments.Max(x => x.midY);
            var tolX = Math.Max(0.25, 0.02 * Math.Max(1e-9, maxX - minX));
            var tolY = Math.Max(0.25, 0.02 * Math.Max(1e-9, maxY - minY));

            bool IsVertical((int loopIndex, int segmentIndex, long hostId, long linkedElementId, XYZ start, XYZ end, XYZ midpoint, XYZ direction, double midX, double midY, double lenFt, double dirX, double dirY) s) => Math.Abs(s.dirY) >= Math.Abs(s.dirX);
            bool IsHorizontal((int loopIndex, int segmentIndex, long hostId, long linkedElementId, XYZ start, XYZ end, XYZ midpoint, XYZ direction, double midX, double midY, double lenFt, double dirX, double dirY) s) => Math.Abs(s.dirX) > Math.Abs(s.dirY);

            IEnumerable<(int loopIndex, int segmentIndex, long hostId, long linkedElementId, XYZ start, XYZ end, XYZ midpoint, XYZ direction, double midX, double midY, double lenFt, double dirX, double dirY)> filtered = rawSegments;
            if (wantedSide == "left") filtered = rawSegments.Where(IsVertical).Where(x => x.midX <= minX + tolX);
            else if (wantedSide == "right") filtered = rawSegments.Where(IsVertical).Where(x => x.midX >= maxX - tolX);
            else if (wantedSide == "bottom") filtered = rawSegments.Where(IsHorizontal).Where(x => x.midY <= minY + tolY);
            else if (wantedSide == "top") filtered = rawSegments.Where(IsHorizontal).Where(x => x.midY >= maxY - tolY);

            return filtered
                .GroupBy(x => new { x.hostId, x.linkedElementId })
                .Select(g =>
                {
                    var hostElement = doc.GetElement(ElementIdCompat.Create(g.Key.hostId));
                    var boundaryElement = hostElement;
                    if (hostElement is RevitLinkInstance linkHost && g.Key.linkedElementId > 0)
                    {
                        try
                        {
                            var linkDoc = linkHost.GetLinkDocument();
                            if (linkDoc != null) boundaryElement = linkDoc.GetElement(ElementIdCompat.Create(g.Key.linkedElementId));
                        }
                        catch { }
                    }
                    var wall = hostElement is RevitLinkInstance ? null : boundaryElement as Wall;
                    var midpoint = new XYZ(g.Average(x => x.midpoint.X), g.Average(x => x.midpoint.Y), g.Average(x => x.midpoint.Z));
                    var geometrySegments = g.Select(x => new RoomWallSegmentGeometry
                    {
                        start = x.start,
                        end = x.end,
                        midpoint = x.midpoint,
                        direction = x.direction,
                        lengthFt = Math.Max(0.0, x.lenFt)
                    }).ToList();
                    XYZ? tangent = geometrySegments
                        .Select(x => x.direction)
                        .Where(x => x != null && x.GetLength() > 1e-9)
                        .Select(x => x.Normalize())
                        .DefaultIfEmpty(XYZ.Zero)
                        .Aggregate((acc, next) => acc + next);
                    if (tangent != null && tangent.GetLength() > 1e-9) tangent = tangent.Normalize();
                    else tangent = null;
                    XYZ? projectedRoomPoint = null;
                    XYZ? interior = null;
                    if (wall != null && TryProjectPointToWall(wall, roomPoint, out var projected, out var t, out _, out _))
                    {
                        tangent = t;
                        projectedRoomPoint = projected;
                        var towardRoom = roomPoint - projected;
                        if (towardRoom.GetLength() > 1e-9) interior = towardRoom.Normalize();
                    }
                    else if (TryProjectPointToRoomWall(new RoomWallResolution { geometrySegments = geometrySegments, boundaryLengthFt = g.Sum(x => Math.Max(0.0, x.lenFt)) }, roomPoint, out var projectedBoundary, out var boundaryTangent, out _, out _))
                    {
                        tangent = boundaryTangent;
                        projectedRoomPoint = projectedBoundary;
                        var towardRoom = roomPoint - projectedBoundary;
                        if (towardRoom.GetLength() > 1e-9) interior = towardRoom.Normalize();
                    }

                    return new RoomWallResolution
                    {
                        hostElementId = g.Key.hostId,
                        boundaryElementId = g.Key.linkedElementId > 0 ? g.Key.linkedElementId : g.Key.hostId,
                        linkedElementId = g.Key.linkedElementId > 0 ? g.Key.linkedElementId : (long?)null,
                        hostElement = hostElement,
                        boundaryElement = boundaryElement,
                        wall = wall,
                        boundaryLengthFt = g.Sum(x => Math.Max(0.0, x.lenFt)),
                        midpoint = midpoint,
                        tangent = tangent,
                        projectedRoomPoint = projectedRoomPoint,
                        interiorDirection = interior,
                        supportsPlacement = IsSupportedPlacementHost(hostElement),
                        geometrySegments = geometrySegments,
                        segments = g.Select(x => (object)new
                        {
                            loopIndex = x.loopIndex,
                            segmentIndex = x.segmentIndex,
                            hostElementId = x.hostId,
                            boundaryElementId = x.linkedElementId > 0 ? x.linkedElementId : x.hostId,
                            linkedElementId = x.linkedElementId > 0 ? x.linkedElementId : (long?)null,
                            midpoint = new { x = x.midpoint.X, y = x.midpoint.Y, z = x.midpoint.Z },
                            midpointInView = new { x = x.midX, y = x.midY },
                            direction = new { x = x.direction.X, y = x.direction.Y, z = x.direction.Z },
                            directionInView = new { x = x.dirX, y = x.dirY },
                            lengthFt = x.lenFt
                        }).ToList()
                    };
                })
                .OrderByDescending(x => x.boundaryLengthFt)
                .Take(Math.Max(1, Math.Min(12, maxWalls)))
                .ToList();
        }

        internal static List<NearbyHostCandidate> FindNearbyHosts(
            Document doc,
            View view,
            XYZ searchPoint,
            IEnumerable<string>? hostCategories,
            double radiusFt,
            SpatialElement? spatial,
            string? roomSide,
            int maxHosts)
        {
            var allowedHostIds = new HashSet<long>();
            var seededHostIds = new HashSet<long>();
            var roomWallMatches = new List<RoomWallResolution>();
            if (spatial != null && !string.IsNullOrWhiteSpace(roomSide))
            {
                roomWallMatches = ResolveRoomWalls(doc, spatial, view, roomSide, maxHosts * 2);
                foreach (var wall in roomWallMatches)
                {
                    allowedHostIds.Add(wall.hostElementId);
                }
            }

            SelectionUtil.TryParseBuiltInCategories(hostCategories?.ToList(), out var hostBics, out _);
            FilteredElementCollector collector;
            try { collector = new FilteredElementCollector(doc, view.Id).WhereElementIsNotElementType(); }
            catch { collector = new FilteredElementCollector(doc).WhereElementIsNotElementType(); }

            if (hostBics.Count > 0)
            {
                collector = collector.WherePasses(new ElementMulticategoryFilter(hostBics.Select(x => ElementIdCompat.Create((long)x)).ToList()));
            }

            var results = new List<NearbyHostCandidate>();
            foreach (var resolution in roomWallMatches)
            {
                var hostElement = resolution.hostElement;
                if (hostElement == null || seededHostIds.Contains(resolution.hostElementId)) continue;
                if (!string.IsNullOrWhiteSpace(roomSide) && !allowedHostIds.Contains(resolution.hostElementId)) continue;

                XYZ? projectedPoint = null;
                XYZ? tangent = resolution.tangent;
                double? hostOffsetFt = null;
                if (TryProjectPointToRoomWall(resolution, searchPoint, out var projected, out var roomWallTangent, out _, out var offset))
                {
                    projectedPoint = projected;
                    tangent = roomWallTangent;
                    hostOffsetFt = offset;
                }

                var point = projectedPoint ?? resolution.midpoint ?? TryGetElementPoint(hostElement);
                if (point == null) continue;
                var distance = ViewPlaneDistanceFt(view, point, searchPoint);
                if (distance > Math.Max(0.25, radiusFt)) continue;

                seededHostIds.Add(resolution.hostElementId);
                results.Add(new NearbyHostCandidate
                {
                    element = hostElement,
                    distanceFt = distance,
                    onRequestedRoomSide = true,
                    supportsPlacement = IsSupportedPlacementHost(hostElement),
                    point = point,
                    projectedPointOnHost = projectedPoint,
                    hostTangent = tangent,
                    hostOffsetFt = hostOffsetFt
                });
            }

            foreach (var candidate in collector)
            {
                if (candidate == null) continue;
                if (!SelectionUtil.MatchesCategoryFilter(candidate, hostCategories))
                    continue;
                var candidateId = ElementIdCompat.GetValue(candidate.Id);
                if (seededHostIds.Contains(candidateId))
                    continue;

                var point = TryGetElementPoint(candidate);
                if (point == null) continue;
                var distance = ViewPlaneDistanceFt(view, point, searchPoint);

                XYZ? projectedPoint = null;
                XYZ? tangent = null;
                double? hostOffsetFt = null;
                if (candidate is Wall wall && TryProjectPointToWall(wall, searchPoint, out var projected, out var wallTangent, out _, out var offset))
                {
                    projectedPoint = projected;
                    tangent = wallTangent;
                    hostOffsetFt = offset;
                    distance = Math.Min(distance, ViewPlaneDistanceFt(view, projected, searchPoint));
                }

                if (distance > Math.Max(0.25, radiusFt)) continue;

                results.Add(new NearbyHostCandidate
                {
                    element = candidate,
                    distanceFt = distance,
                    onRequestedRoomSide = allowedHostIds.Count > 0 && allowedHostIds.Contains(ElementIdCompat.GetValue(candidate.Id)),
                    supportsPlacement = IsSupportedPlacementHost(candidate),
                    point = point,
                    projectedPointOnHost = projectedPoint,
                    hostTangent = tangent,
                    hostOffsetFt = hostOffsetFt
                });
            }

            return results
                .OrderByDescending(x => x.onRequestedRoomSide)
                .ThenByDescending(x => x.supportsPlacement)
                .ThenBy(x => x.distanceFt)
                .Take(Math.Max(1, Math.Min(40, maxHosts)))
                .ToList();
        }

        internal static void CopyParameters(Element source, Element target, IEnumerable<string>? parameterNames, List<string> warnings)
        {
            if (source == null || target == null || parameterNames == null) return;
            foreach (var rawName in parameterNames)
            {
                var name = (rawName ?? "").Trim();
                if (name.Length == 0) continue;
                try
                {
                    var from = source.LookupParameter(name);
                    var to = target.LookupParameter(name);
                    if (from == null || to == null || to.IsReadOnly) continue;
                    if (from.StorageType != to.StorageType) continue;

                    switch (from.StorageType)
                    {
                        case StorageType.String:
                            to.Set(from.AsString() ?? "");
                            break;
                        case StorageType.Double:
                            to.Set(from.AsDouble());
                            break;
                        case StorageType.Integer:
                            to.Set(from.AsInteger());
                            break;
                        case StorageType.ElementId:
                            to.Set(from.AsElementId());
                            break;
                    }
                }
                catch (Exception ex)
                {
                    warnings.Add($"Failed to copy parameter '{name}': {ex.Message}");
                }
            }
        }

        internal static void ApplyParameterValues(Element target, IDictionary<string, string>? values, List<string> warnings)
        {
            if (target == null || values == null) return;
            foreach (var kvp in values)
            {
                var name = (kvp.Key ?? "").Trim();
                if (name.Length == 0) continue;
                try
                {
                    var param = target.LookupParameter(name);
                    if (param == null || param.IsReadOnly) continue;
                    var value = kvp.Value ?? "";
                    switch (param.StorageType)
                    {
                        case StorageType.String:
                            param.Set(value);
                            break;
                        case StorageType.Integer:
                            if (int.TryParse(value, NumberStyles.Integer, CultureInfo.InvariantCulture, out var i)) param.Set(i);
                            break;
                        case StorageType.Double:
                            if (double.TryParse(value, NumberStyles.Float | NumberStyles.AllowThousands, CultureInfo.InvariantCulture, out var d)) param.Set(d);
                            break;
                        case StorageType.ElementId:
                            if (long.TryParse(value, NumberStyles.Integer, CultureInfo.InvariantCulture, out var id))
                                param.Set(ElementIdCompat.Create(id));
                            break;
                    }
                }
                catch (Exception ex)
                {
                    warnings.Add($"Failed to set parameter '{name}': {ex.Message}");
                }
            }
        }

        internal static void ApplyParameterValuesStrict(Element target, IDictionary<string, string>? values)
        {
            if (target == null) throw new InvalidOperationException("Parameter override target is required.");
            if (values == null || values.Count == 0) return;

            foreach (var kvp in values)
            {
                var name = (kvp.Key ?? "").Trim();
                if (name.Length == 0) throw new InvalidOperationException("Parameter override name is required.");
                var param = target.LookupParameter(name)
                    ?? throw new InvalidOperationException($"Parameter override '{name}' was not found on the created instance.");
                if (param.IsReadOnly) throw new InvalidOperationException($"Parameter override '{name}' is read-only on the created instance.");

                var value = kvp.Value ?? "";
                bool changed;
                switch (param.StorageType)
                {
                    case StorageType.String:
                        changed = param.Set(value);
                        break;
                    case StorageType.Integer:
                        if (!int.TryParse(value, NumberStyles.Integer, CultureInfo.InvariantCulture, out var integerValue))
                            throw new InvalidOperationException($"Parameter override '{name}' requires an integer value.");
                        changed = param.Set(integerValue);
                        break;
                    case StorageType.Double:
                        if (!double.TryParse(value, NumberStyles.Float | NumberStyles.AllowThousands, CultureInfo.InvariantCulture, out var doubleValue))
                            throw new InvalidOperationException($"Parameter override '{name}' requires a numeric internal-unit value.");
                        changed = param.Set(doubleValue);
                        break;
                    case StorageType.ElementId:
                        if (!long.TryParse(value, NumberStyles.Integer, CultureInfo.InvariantCulture, out var elementIdValue))
                            throw new InvalidOperationException($"Parameter override '{name}' requires an element id value.");
                        changed = param.Set(ElementIdCompat.Create(elementIdValue));
                        break;
                    default:
                        throw new InvalidOperationException($"Parameter override '{name}' has unsupported storage type {param.StorageType}.");
                }

                if (!changed) throw new InvalidOperationException($"Parameter override '{name}' was rejected by Revit.");
            }

            target.Document.Regenerate();
            foreach (var kvp in values)
            {
                var name = (kvp.Key ?? "").Trim();
                var value = kvp.Value ?? "";
                var param = target.LookupParameter(name)
                    ?? throw new InvalidOperationException($"Parameter override '{name}' disappeared before readback.");
                var matches = param.StorageType switch
                {
                    StorageType.String => string.Equals(param.AsString() ?? "", value, StringComparison.Ordinal),
                    StorageType.Integer => int.TryParse(value, NumberStyles.Integer, CultureInfo.InvariantCulture, out var integerValue)
                        && param.AsInteger() == integerValue,
                    StorageType.Double => double.TryParse(value, NumberStyles.Float | NumberStyles.AllowThousands, CultureInfo.InvariantCulture, out var doubleValue)
                        && Math.Abs(param.AsDouble() - doubleValue) <= 1e-9,
                    StorageType.ElementId => long.TryParse(value, NumberStyles.Integer, CultureInfo.InvariantCulture, out var elementIdValue)
                        && ElementIdCompat.GetValue(param.AsElementId()) == elementIdValue,
                    _ => false
                };
                if (!matches) throw new InvalidOperationException($"Parameter override '{name}' did not match requested value after readback.");
            }
        }

        internal static void ApplyResolvedLevelToFaceHostedInstance(FamilyInstance instance, Level level, List<string> warnings)
        {
            if (instance == null || level == null) return;
            var candidates = new[]
            {
                instance.get_Parameter(BuiltInParameter.INSTANCE_SCHEDULE_ONLY_LEVEL_PARAM),
                instance.get_Parameter(BuiltInParameter.FAMILY_LEVEL_PARAM),
                instance.get_Parameter(BuiltInParameter.INSTANCE_REFERENCE_LEVEL_PARAM)
            };
            foreach (var parameter in candidates.Where(value => value != null).Distinct())
            {
                if (parameter == null || parameter.IsReadOnly || parameter.StorageType != StorageType.ElementId) continue;
                try
                {
                    parameter.Set(level.Id);
                    return;
                }
                catch (Exception ex)
                {
                    warnings.Add($"Failed to set face-hosted instance level '{level.Name}': {ex.Message}");
                }
            }
            warnings.Add($"Face-hosted instance did not expose a writable schedule/reference level for '{level.Name}'.");
        }

        internal static object? ApplyAndAuditElectricalDistributionSystem(
            Document doc,
            FamilyInstance instance,
            string? requestedName)
        {
            if (instance == null || instance.Category?.BuiltInCategory != BuiltInCategory.OST_ElectricalEquipment)
            {
                if (!string.IsNullOrWhiteSpace(requestedName))
                    throw new InvalidOperationException("distributionSystemName requires an electrical-equipment family instance.");
                return null;
            }

            var settings = ElectricalSetting.GetElectricalSettings(doc)
                ?? throw new InvalidOperationException("Electrical settings are unavailable in the active document.");
            var all = new List<DistributionSysType>();
            foreach (DistributionSysType candidate in settings.DistributionSysTypes)
            {
                if (candidate != null) all.Add(candidate);
            }

            var equipment = instance.MEPModel as ElectricalEquipment
                ?? throw new InvalidOperationException("electrical_equipment_mep_model_unavailable");
            var compatible = all.Where(candidate =>
            {
                try { return equipment.IsValidDistributionSystem(candidate); }
                catch { return false; }
            }).OrderBy(candidate => candidate.Name, StringComparer.OrdinalIgnoreCase).ToList();

            var requested = (requestedName ?? "").Trim();
            if (requested.Length > 0)
            {
                var exact = all.Where(candidate => string.Equals(candidate.Name, requested, StringComparison.OrdinalIgnoreCase)).ToList();
                if (exact.Count != 1)
                    throw new InvalidOperationException($"distribution_system_name_not_unique:{requested}:matches={exact.Count}");
                if (!compatible.Any(candidate => candidate.Id == exact[0].Id))
                {
                    var compatibleNames = compatible.Count == 0 ? "none" : string.Join(", ", compatible.Select(candidate => candidate.Name));
                    throw new InvalidOperationException($"distribution_system_not_compatible:{requested}:compatible={compatibleNames}");
                }
                equipment.DistributionSystem = exact[0];
                doc.Regenerate();
                if (equipment.DistributionSystem == null || equipment.DistributionSystem.Id != exact[0].Id)
                    throw new InvalidOperationException($"distribution_system_assignment_not_verified:{requested}");
            }

            var assigned = equipment.DistributionSystem;
            return new
            {
                requestedName = requested.Length > 0 ? requested : null,
                assigned = assigned == null ? null : new
                {
                    id = ElementIdCompat.GetValue(assigned.Id),
                    name = assigned.Name,
                    electricalPhase = assigned.ElectricalPhase.ToString(),
                    phaseConfiguration = assigned.ElectricalPhaseConfiguration.ToString(),
                    numWires = assigned.NumWires,
                    voltageLineToLine = assigned.VoltageLineToLine?.ActualValue,
                    voltageLineToGround = assigned.VoltageLineToGround?.ActualValue,
                    voltageLineToLineDefinition = assigned.VoltageLineToLine == null ? null : new
                    {
                        id = ElementIdCompat.GetValue(assigned.VoltageLineToLine.Id),
                        name = assigned.VoltageLineToLine.Name,
                        actualValue = assigned.VoltageLineToLine.ActualValue,
                        minValue = assigned.VoltageLineToLine.MinValue,
                        maxValue = assigned.VoltageLineToLine.MaxValue
                    },
                    voltageLineToGroundDefinition = assigned.VoltageLineToGround == null ? null : new
                    {
                        id = ElementIdCompat.GetValue(assigned.VoltageLineToGround.Id),
                        name = assigned.VoltageLineToGround.Name,
                        actualValue = assigned.VoltageLineToGround.ActualValue,
                        minValue = assigned.VoltageLineToGround.MinValue,
                        maxValue = assigned.VoltageLineToGround.MaxValue
                    }
                },
                available = all.OrderBy(candidate => candidate.Name, StringComparer.OrdinalIgnoreCase).Select(candidate => new
                {
                    id = ElementIdCompat.GetValue(candidate.Id),
                    name = candidate.Name,
                    electricalPhase = candidate.ElectricalPhase.ToString(),
                    phaseConfiguration = candidate.ElectricalPhaseConfiguration.ToString(),
                    numWires = candidate.NumWires,
                    voltageLineToLine = candidate.VoltageLineToLine?.ActualValue,
                    voltageLineToGround = candidate.VoltageLineToGround?.ActualValue,
                    voltageLineToLineDefinition = candidate.VoltageLineToLine == null ? null : new
                    {
                        id = ElementIdCompat.GetValue(candidate.VoltageLineToLine.Id),
                        name = candidate.VoltageLineToLine.Name,
                        actualValue = candidate.VoltageLineToLine.ActualValue,
                        minValue = candidate.VoltageLineToLine.MinValue,
                        maxValue = candidate.VoltageLineToLine.MaxValue
                    },
                    voltageLineToGroundDefinition = candidate.VoltageLineToGround == null ? null : new
                    {
                        id = ElementIdCompat.GetValue(candidate.VoltageLineToGround.Id),
                        name = candidate.VoltageLineToGround.Name,
                        actualValue = candidate.VoltageLineToGround.ActualValue,
                        minValue = candidate.VoltageLineToGround.MinValue,
                        maxValue = candidate.VoltageLineToGround.MaxValue
                    }
                }).ToList(),
                compatible = compatible.Select(candidate => new
                {
                    id = ElementIdCompat.GetValue(candidate.Id),
                    name = candidate.Name,
                    electricalPhase = candidate.ElectricalPhase.ToString(),
                    phaseConfiguration = candidate.ElectricalPhaseConfiguration.ToString(),
                    numWires = candidate.NumWires,
                    voltageLineToLine = candidate.VoltageLineToLine?.ActualValue,
                    voltageLineToGround = candidate.VoltageLineToGround?.ActualValue,
                    voltageLineToLineDefinition = candidate.VoltageLineToLine == null ? null : new
                    {
                        id = ElementIdCompat.GetValue(candidate.VoltageLineToLine.Id),
                        name = candidate.VoltageLineToLine.Name,
                        actualValue = candidate.VoltageLineToLine.ActualValue,
                        minValue = candidate.VoltageLineToLine.MinValue,
                        maxValue = candidate.VoltageLineToLine.MaxValue
                    },
                    voltageLineToGroundDefinition = candidate.VoltageLineToGround == null ? null : new
                    {
                        id = ElementIdCompat.GetValue(candidate.VoltageLineToGround.Id),
                        name = candidate.VoltageLineToGround.Name,
                        actualValue = candidate.VoltageLineToGround.ActualValue,
                        minValue = candidate.VoltageLineToGround.MinValue,
                        maxValue = candidate.VoltageLineToGround.MaxValue
                    }
                }).ToList()
            };
        }

        internal static object? EnsureElectricalDistributionSystem(
            Document doc,
            ElectricalDistributionSystemDefinitionRequest? request)
        {
            if (request == null) return null;
            var requestedName = (request.name ?? "").Trim();
            if (requestedName.Length == 0) throw new InvalidOperationException("ensureDistributionSystem.name is required.");
            if (!Enum.TryParse(request.electricalPhase ?? "", true, out ElectricalPhase phase))
                throw new InvalidOperationException($"invalid_electrical_phase:{request.electricalPhase}");
            if (!Enum.TryParse(request.phaseConfiguration ?? "", true, out ElectricalPhaseConfiguration phaseConfiguration))
                throw new InvalidOperationException($"invalid_electrical_phase_configuration:{request.phaseConfiguration}");
            if (request.numWires < 2 || request.numWires > 4)
                throw new InvalidOperationException($"invalid_distribution_system_wire_count:{request.numWires}");

            var settings = ElectricalSetting.GetElectricalSettings(doc)
                ?? throw new InvalidOperationException("Electrical settings are unavailable in the active document.");
            var createdVoltageTypeNames = new List<string>();

            VoltageType? ResolveVoltage(ElectricalVoltageDefinitionRequest? definition, string role)
            {
                if (definition == null) return null;
                var name = (definition.name ?? "").Trim();
                if (name.Length == 0) throw new InvalidOperationException($"ensureDistributionSystem.{role}.name is required.");
                if (definition.minValue > definition.actualValue || definition.actualValue > definition.maxValue)
                    throw new InvalidOperationException($"invalid_voltage_range:{role}:{definition.minValue}:{definition.actualValue}:{definition.maxValue}");

                var matches = new List<VoltageType>();
                foreach (VoltageType voltageType in settings.VoltageTypes)
                {
                    if (voltageType != null && string.Equals(voltageType.Name, name, StringComparison.OrdinalIgnoreCase))
                        matches.Add(voltageType);
                }
                if (matches.Count > 1) throw new InvalidOperationException($"voltage_type_name_not_unique:{name}:matches={matches.Count}");
                if (matches.Count == 1)
                {
                    var existing = matches[0];
                    if (Math.Abs(existing.ActualValue - definition.actualValue) > 1e-6 ||
                        Math.Abs(existing.MinValue - definition.minValue) > 1e-6 ||
                        Math.Abs(existing.MaxValue - definition.maxValue) > 1e-6)
                    {
                        throw new InvalidOperationException($"voltage_type_definition_mismatch:{name}");
                    }
                    return existing;
                }

                var created = settings.AddVoltageType(name, definition.actualValue, definition.minValue, definition.maxValue);
                createdVoltageTypeNames.Add(name);
                return created;
            }

            var voltageLineToLine = ResolveVoltage(request.voltageLineToLine, "voltageLineToLine");
            var voltageLineToGround = ResolveVoltage(request.voltageLineToGround, "voltageLineToGround");
            var distributionMatches = new List<DistributionSysType>();
            foreach (DistributionSysType candidate in settings.DistributionSysTypes)
            {
                if (candidate != null && string.Equals(candidate.Name, requestedName, StringComparison.OrdinalIgnoreCase))
                    distributionMatches.Add(candidate);
            }
            if (distributionMatches.Count > 1)
                throw new InvalidOperationException($"distribution_system_name_not_unique:{requestedName}:matches={distributionMatches.Count}");

            var createdDistributionSystem = false;
            DistributionSysType distributionSystem;
            if (distributionMatches.Count == 1)
            {
                distributionSystem = distributionMatches[0];
                var definitionMatches = distributionSystem.ElectricalPhase == phase &&
                    distributionSystem.ElectricalPhaseConfiguration == phaseConfiguration &&
                    distributionSystem.NumWires == request.numWires &&
                    (voltageLineToLine == null
                        ? distributionSystem.VoltageLineToLine == null
                        : distributionSystem.VoltageLineToLine?.Id == voltageLineToLine.Id) &&
                    (voltageLineToGround == null
                        ? distributionSystem.VoltageLineToGround == null
                        : distributionSystem.VoltageLineToGround?.Id == voltageLineToGround.Id);
                if (!definitionMatches)
                    throw new InvalidOperationException($"distribution_system_definition_mismatch:{requestedName}");
            }
            else
            {
                distributionSystem = settings.AddDistributionSysType(
                    requestedName,
                    phase,
                    phaseConfiguration,
                    request.numWires,
                    voltageLineToLine,
                    voltageLineToGround);
                createdDistributionSystem = true;
            }

            doc.Regenerate();
            return new
            {
                requestedName,
                createdDistributionSystem,
                createdVoltageTypeNames,
                verified = distributionSystem != null && string.Equals(distributionSystem.Name, requestedName, StringComparison.OrdinalIgnoreCase),
                distributionSystem = new
                {
                    id = ElementIdCompat.GetValue(distributionSystem.Id),
                    name = distributionSystem.Name,
                    electricalPhase = distributionSystem.ElectricalPhase.ToString(),
                    phaseConfiguration = distributionSystem.ElectricalPhaseConfiguration.ToString(),
                    numWires = distributionSystem.NumWires,
                    voltageLineToLine = distributionSystem.VoltageLineToLine?.ActualValue,
                    voltageLineToGround = distributionSystem.VoltageLineToGround?.ActualValue
                }
            };
        }

        internal static bool TryMatchElectricalCircuitFromSource(
            Element? sourceElement,
            FamilyInstance created,
            bool requireMatch,
            List<string> warnings,
            out string detail)
        {
            detail = "";
            var sourceFi = sourceElement as FamilyInstance;
            if (sourceFi == null)
            {
                detail = "Electrical circuit match requires a family-instance source exemplar.";
                return !requireMatch;
            }

            var sourceCircuit = ResolvePreferredElectricalSystem(sourceFi);
            if (sourceCircuit == null)
            {
                detail = "Source exemplar has no resolvable electrical circuit to match.";
                return !requireMatch;
            }

            var sourceCircuitLabel = BuildElectricalCircuitLabel(sourceFi, sourceCircuit);
            if (!TryAddFamilyInstanceToElectricalSystem(sourceCircuit, created, out var addError))
            {
                detail = $"Failed to add the new instance to the source electrical circuit{(sourceCircuitLabel.Length > 0 ? $" ({sourceCircuitLabel})" : "")}: {addError}";
                return !requireMatch;
            }

            try { created.Document.Regenerate(); } catch { }

            var createdLabel = BuildElectricalCircuitLabel(created, sourceCircuit);
            if (requireMatch)
            {
                var sourceNormalized = NormalizeElectricalCircuitLabel(sourceCircuitLabel);
                var createdNormalized = NormalizeElectricalCircuitLabel(createdLabel);
                if (sourceNormalized.Length > 0 && createdNormalized.Length > 0 && !string.Equals(sourceNormalized, createdNormalized, StringComparison.OrdinalIgnoreCase))
                {
                    detail = $"New instance joined an unexpected electrical circuit. Expected {sourceCircuitLabel}, got {createdLabel}.";
                    return false;
                }
                if (sourceNormalized.Length > 0 && createdNormalized.Length == 0)
                {
                    detail = $"New instance did not report an electrical circuit after matching source circuit {sourceCircuitLabel}.";
                    return false;
                }
            }

            detail = createdLabel.Length > 0
                ? $"Matched electrical circuit from the source exemplar ({createdLabel})."
                : "Matched the source exemplar's electrical circuit.";
            return true;
        }

        internal static bool TryReassignElectricalCircuitFromSource(
            Element? sourceElement,
            FamilyInstance target,
            bool requireMatch,
            List<string> warnings,
            out string detail)
        {
            detail = "";
            var sourceFi = sourceElement as FamilyInstance;
            if (sourceFi == null)
            {
                detail = "Electrical circuit reassignment requires a family-instance source exemplar.";
                return !requireMatch;
            }

            var sourceCircuit = ResolvePreferredElectricalSystem(sourceFi);
            if (sourceCircuit == null)
            {
                detail = "Source exemplar has no resolvable electrical circuit to match.";
                return !requireMatch;
            }

            var sourceLabel = BuildElectricalCircuitLabel(sourceFi, sourceCircuit);
            var sourceSystemId = TryGetElectricalSystemId(sourceCircuit);
            var sourceNormalized = NormalizeElectricalCircuitLabel(sourceLabel);
            var targetSystemsBefore = GetElectricalSystems(target);
            var removedLabels = new List<string>();

            foreach (var existingSystem in targetSystemsBefore)
            {
                var existingLabel = BuildElectricalCircuitLabel(target, existingSystem);
                var existingNormalized = NormalizeElectricalCircuitLabel(existingLabel);
                if (sourceNormalized.Length > 0 && string.Equals(existingNormalized, sourceNormalized, StringComparison.OrdinalIgnoreCase))
                    continue;

                if (!TryRemoveFamilyInstanceFromElectricalSystem(existingSystem, target, out var removeError))
                {
                    detail = $"Failed to remove the instance from an existing electrical circuit{(existingLabel.Length > 0 ? $" ({existingLabel})" : "")}: {removeError}";
                    return !requireMatch;
                }

                if (existingLabel.Length > 0) removedLabels.Add(existingLabel);
            }

            try { target.Document.Regenerate(); } catch { }

            var targetSystemsAfterRemoval = GetElectricalSystems(target);
            var alreadyMatched = targetSystemsAfterRemoval.Any(system =>
                string.Equals(
                    NormalizeElectricalCircuitLabel(BuildElectricalCircuitLabel(target, system)),
                    sourceNormalized,
                    StringComparison.OrdinalIgnoreCase));

            if (!alreadyMatched)
            {
                if (!TryAddFamilyInstanceToElectricalSystem(sourceCircuit, target, out var addError))
                {
                    detail = $"Failed to add the instance to the source electrical circuit{(sourceLabel.Length > 0 ? $" ({sourceLabel})" : "")}: {addError}";
                    return !requireMatch;
                }
            }

            try { target.Document.Regenerate(); } catch { }

            var finalAudit = BuildElectricalCircuitAuditPayload(target);
            var finalLabel = (finalAudit?.GetType().GetProperty("primaryLabel")?.GetValue(finalAudit)?.ToString() ?? "").Trim();
            var finalNormalized = NormalizeElectricalCircuitLabel(finalLabel);
            if (requireMatch)
            {
                var finalPowerSystemIds = GetPowerElectricalSystemIds(target);
                if (!sourceSystemId.HasValue || !CircuitMatchPolicy.HasExactMembership(sourceSystemId.Value, finalPowerSystemIds))
                {
                    detail = $"Adjusted instance did not join exactly the source power system. Expected system {sourceSystemId?.ToString(CultureInfo.InvariantCulture) ?? "unknown"}; actual power systems: {string.Join(",", finalPowerSystemIds)}.";
                    return false;
                }
                if (sourceNormalized.Length > 0 && finalNormalized.Length > 0 && !string.Equals(sourceNormalized, finalNormalized, StringComparison.OrdinalIgnoreCase))
                {
                    detail = $"Adjusted instance joined an unexpected electrical circuit. Expected {sourceLabel}, got {finalLabel}.";
                    return false;
                }

                if (sourceNormalized.Length > 0 && finalNormalized.Length == 0)
                {
                    detail = $"Adjusted instance did not report an electrical circuit after matching source circuit {sourceLabel}.";
                    return false;
                }
            }

            var removedText = removedLabels.Count > 0
                ? $" Removed prior circuit memberships: {string.Join(", ", removedLabels.Distinct(StringComparer.OrdinalIgnoreCase))}."
                : "";
            detail = finalLabel.Length > 0
                ? $"Matched electrical circuit from the source exemplar ({finalLabel}).{removedText}"
                : $"Matched the source exemplar's electrical circuit.{removedText}";
            return true;
        }

        internal static object BuildElectricalCircuitAuditPayload(FamilyInstance? instance)
        {
            var labels = new List<string>();
            var normalized = new List<string>();
            var systems = instance == null ? new List<object>() : GetElectricalSystems(instance);
            var systemIds = systems.Select(TryGetElectricalSystemId).Where(id => id.HasValue).Select(id => id!.Value).Distinct().OrderBy(id => id).ToList();
            var powerSystemIds = systems.Where(LooksLikePowerCircuit).Select(TryGetElectricalSystemId).Where(id => id.HasValue).Select(id => id!.Value).Distinct().OrderBy(id => id).ToList();
            if (instance != null)
            {
                foreach (var system in systems)
                {
                    var label = BuildElectricalCircuitLabel(instance, system);
                    if (label.Length == 0) continue;
                    labels.Add(label);
                    var normalizedLabel = NormalizeElectricalCircuitLabel(label);
                    if (normalizedLabel.Length > 0) normalized.Add(normalizedLabel);
                }
            }

            labels = labels.Distinct(StringComparer.OrdinalIgnoreCase).ToList();
            normalized = normalized.Distinct(StringComparer.OrdinalIgnoreCase).ToList();
            var panel = (instance?.LookupParameter("Panel")?.AsString() ?? instance?.LookupParameter("Panel")?.AsValueString() ?? "").Trim();
            var circuitNumber = (instance?.LookupParameter("Circuit Number")?.AsString() ?? instance?.LookupParameter("Circuit Number")?.AsValueString() ?? "").Trim();
            var primaryLabel = labels.FirstOrDefault() ?? (panel.Length > 0 || circuitNumber.Length > 0 ? $"{panel}/{circuitNumber}".Trim('/').Trim() : "");
            return new
            {
                panel = panel.Length > 0 ? panel : null,
                circuitNumber = circuitNumber.Length > 0 ? circuitNumber : null,
                primaryLabel = primaryLabel.Length > 0 ? primaryLabel : null,
                labels,
                normalizedLabels = normalized,
                systemCount = systems.Count,
                systemIds,
                powerSystemIds,
                exactPowerSystemCount = powerSystemIds.Count
            };
        }

        internal static List<long> GetPowerElectricalSystemIds(FamilyInstance? instance)
        {
            if (instance == null) return new List<long>();
            return GetElectricalSystems(instance)
                .Where(LooksLikePowerCircuit)
                .Select(TryGetElectricalSystemId)
                .Where(id => id.HasValue)
                .Select(id => id!.Value)
                .Distinct()
                .OrderBy(id => id)
                .ToList();
        }

        private static object? ResolvePreferredElectricalSystem(FamilyInstance sourceFi)
        {
            var systems = GetElectricalSystems(sourceFi);
            if (systems.Count == 0) return null;

            var preferred = systems.FirstOrDefault(system => LooksLikePowerCircuit(system));
            return preferred ?? systems[0];
        }

        private static List<object> GetElectricalSystems(FamilyInstance familyInstance)
        {
            var output = new List<object>();
            var mepModel = familyInstance?.MEPModel;
            if (mepModel == null) return output;

            foreach (var memberName in new[] { "GetElectricalSystems", "ElectricalSystems" })
            {
                try
                {
                    object? value = null;
                    if (memberName.StartsWith("Get", StringComparison.Ordinal))
                    {
                        var method = mepModel.GetType().GetMethod(memberName, BindingFlags.Instance | BindingFlags.Public, null, Type.EmptyTypes, null);
                        if (method != null) value = method.Invoke(mepModel, null);
                    }
                    else
                    {
                        var property = mepModel.GetType().GetProperty(memberName, BindingFlags.Instance | BindingFlags.Public);
                        if (property != null) value = property.GetValue(mepModel);
                    }

                    foreach (var item in EnumerateObjects(value))
                    {
                        if (item == null) continue;
                        if (item is ElectricalSystem) output.Add(item);
                        else if (item.GetType().Name.IndexOf("ElectricalSystem", StringComparison.OrdinalIgnoreCase) >= 0) output.Add(item);
                    }
                }
                catch
                {
                    // best effort
                }
            }

            return output.Distinct().ToList();
        }

        private static IEnumerable<object> EnumerateObjects(object? value)
        {
            if (value == null) yield break;
            if (value is System.Collections.IEnumerable enumerable)
            {
                foreach (var item in enumerable)
                {
                    if (item != null) yield return item;
                }
                yield break;
            }

            yield return value;
        }

        private static bool LooksLikePowerCircuit(object system)
        {
            if (system == null) return false;
            foreach (var propertyName in new[] { "SystemType", "CircuitType" })
            {
                try
                {
                    var property = system.GetType().GetProperty(propertyName, BindingFlags.Instance | BindingFlags.Public);
                    var value = property?.GetValue(system);
                    var text = (value?.ToString() ?? "").Trim();
                    if (text.IndexOf("Power", StringComparison.OrdinalIgnoreCase) >= 0) return true;
                }
                catch
                {
                    // best effort
                }
            }

            return false;
        }

        private static long? TryGetElectricalSystemId(object? system)
        {
            if (system is Element element) return ElementIdCompat.GetValue(element.Id);
            try
            {
                var value = system?.GetType().GetProperty("Id", BindingFlags.Instance | BindingFlags.Public)?.GetValue(system);
                if (value is ElementId id) return ElementIdCompat.GetValue(id);
            }
            catch { }
            return null;
        }

        private static bool TryAddFamilyInstanceToElectricalSystem(object system, FamilyInstance created, out string error)
        {
            error = "";
            if (system == null)
            {
                error = "Electrical system was null.";
                return false;
            }

            var methods = system.GetType()
                .GetMethods(BindingFlags.Instance | BindingFlags.Public)
                .Where(method => string.Equals(method.Name, "Add", StringComparison.OrdinalIgnoreCase) || string.Equals(method.Name, "AddToCircuit", StringComparison.OrdinalIgnoreCase))
                .Where(method => method.GetParameters().Length == 1)
                .ToList();

            if (methods.Count == 0)
            {
                error = "No supported Add/AddToCircuit API was available on the electrical system.";
                return false;
            }

            foreach (var method in methods)
            {
                var parameter = method.GetParameters()[0];
                try
                {
                    object? argument = null;
                    if (parameter.ParameterType == typeof(ElementId))
                    {
                        argument = created.Id;
                    }
                    else if (parameter.ParameterType == typeof(ElementSet))
                    {
                        var set = new ElementSet();
                        set.Insert(created);
                        argument = set;
                    }
                    else if (parameter.ParameterType.IsArray && parameter.ParameterType.GetElementType() == typeof(ElementId))
                    {
                        argument = new[] { created.Id };
                    }
                    else if (parameter.ParameterType.IsGenericType && parameter.ParameterType.GetGenericArguments().Length == 1 && parameter.ParameterType.GetGenericArguments()[0] == typeof(ElementId))
                    {
                        argument = new List<ElementId> { created.Id };
                    }
                    else if (parameter.ParameterType.IsAssignableFrom(typeof(List<ElementId>)))
                    {
                        argument = new List<ElementId> { created.Id };
                    }

                    if (argument == null) continue;
                    var result = method.Invoke(system, new[] { argument });
                    if (method.ReturnType == typeof(bool) && result is bool ok && !ok)
                    {
                        error = $"{method.Name} returned false.";
                        continue;
                    }
                    return true;
                }
                catch (TargetInvocationException ex)
                {
                    error = ex.InnerException?.Message ?? ex.Message;
                }
                catch (Exception ex)
                {
                    error = ex.Message;
                }
            }

            if (string.IsNullOrWhiteSpace(error))
            {
                error = "No compatible Add/AddToCircuit overload accepted the created element.";
            }
            return false;
        }

        private static bool TryRemoveFamilyInstanceFromElectricalSystem(object system, FamilyInstance instance, out string error)
        {
            error = "";
            if (system == null)
            {
                error = "Electrical system was null.";
                return false;
            }

            var methods = system.GetType()
                .GetMethods(BindingFlags.Instance | BindingFlags.Public)
                .Where(method =>
                    string.Equals(method.Name, "RemoveFromCircuit", StringComparison.OrdinalIgnoreCase) ||
                    string.Equals(method.Name, "Remove", StringComparison.OrdinalIgnoreCase) ||
                    string.Equals(method.Name, "DisconnectPanel", StringComparison.OrdinalIgnoreCase))
                .Where(method => method.GetParameters().Length <= 1)
                .ToList();

            if (methods.Count == 0)
            {
                error = "No supported circuit-removal API was available on the electrical system.";
                return false;
            }

            foreach (var method in methods)
            {
                try
                {
                    object?[] args;
                    if (method.GetParameters().Length == 0)
                    {
                        args = Array.Empty<object?>();
                    }
                    else
                    {
                        var parameter = method.GetParameters()[0];
                        object? argument = null;
                        if (parameter.ParameterType == typeof(ElementId))
                        {
                            argument = instance.Id;
                        }
                        else if (parameter.ParameterType == typeof(ElementSet))
                        {
                            var set = new ElementSet();
                            set.Insert(instance);
                            argument = set;
                        }
                        else if (parameter.ParameterType.IsArray && parameter.ParameterType.GetElementType() == typeof(ElementId))
                        {
                            argument = new[] { instance.Id };
                        }
                        else if (parameter.ParameterType.IsGenericType && parameter.ParameterType.GetGenericArguments().Length == 1 && parameter.ParameterType.GetGenericArguments()[0] == typeof(ElementId))
                        {
                            argument = new List<ElementId> { instance.Id };
                        }
                        else if (parameter.ParameterType.IsAssignableFrom(typeof(List<ElementId>)))
                        {
                            argument = new List<ElementId> { instance.Id };
                        }

                        if (argument == null) continue;
                        args = new[] { argument };
                    }

                    var result = method.Invoke(system, args);
                    if (method.ReturnType == typeof(bool) && result is bool ok && !ok)
                    {
                        error = $"{method.Name} returned false.";
                        continue;
                    }
                    return true;
                }
                catch (TargetInvocationException ex)
                {
                    error = ex.InnerException?.Message ?? ex.Message;
                }
                catch (Exception ex)
                {
                    error = ex.Message;
                }
            }

            if (string.IsNullOrWhiteSpace(error))
            {
                error = "No compatible removal overload accepted the target element.";
            }

            return false;
        }

        private static string BuildElectricalCircuitLabel(FamilyInstance instance, object? system)
        {
            var parts = new List<string>();
            var panel = (instance.LookupParameter("Panel")?.AsString() ?? instance.LookupParameter("Panel")?.AsValueString() ?? "").Trim();
            var circuit = (instance.LookupParameter("Circuit Number")?.AsString() ?? instance.LookupParameter("Circuit Number")?.AsValueString() ?? "").Trim();
            if (panel.Length > 0 && circuit.Length > 0) return $"{panel}/{circuit}";
            if (panel.Length > 0) parts.Add(panel);
            if (circuit.Length > 0) parts.Add(circuit);

            if (system != null)
            {
                foreach (var propertyName in new[] { "PanelName", "CircuitNumber", "CircuitNamingIndex" })
                {
                    try
                    {
                        var property = system.GetType().GetProperty(propertyName, BindingFlags.Instance | BindingFlags.Public);
                        var value = (property?.GetValue(system)?.ToString() ?? "").Trim();
                        if (value.Length > 0) parts.Add(value);
                    }
                    catch
                    {
                        // best effort
                    }
                }
            }

            return string.Join("/", parts.Where(part => part.Length > 0).Distinct(StringComparer.OrdinalIgnoreCase));
        }

        private static string NormalizeElectricalCircuitLabel(string value)
        {
            var trimmed = (value ?? "").Trim();
            if (trimmed.Length == 0) return "";
            var chars = trimmed
                .Select(ch => char.IsLetterOrDigit(ch) ? char.ToUpperInvariant(ch) : '/')
                .ToArray();
            var normalized = new string(chars);
            while (normalized.IndexOf("//", StringComparison.Ordinal) >= 0)
            {
                normalized = normalized.Replace("//", "/");
            }
            return normalized.Trim('/');
        }

        internal static void ApplyRotationAndFlip(Element? exemplar, FamilyInstance created, bool copyRotation, bool copyFacingHandState, List<string> warnings)
        {
            if (exemplar == null || created == null) return;

            if (copyFacingHandState && exemplar is FamilyInstance sourceFi)
            {
                try
                {
                    if (created.HandFlipped != sourceFi.HandFlipped) created.flipHand();
                }
                catch (Exception ex)
                {
                    warnings.Add($"Failed to match hand flip state: {ex.Message}");
                }

                try
                {
                    if (created.FacingFlipped != sourceFi.FacingFlipped) created.flipFacing();
                }
                catch (Exception ex)
                {
                    warnings.Add($"Failed to match facing flip state: {ex.Message}");
                }
            }

            if (!copyRotation) return;
            try
            {
                if (exemplar.Location is not LocationPoint srcPoint) return;
                if (created.Location is not LocationPoint dstPoint) return;
                var delta = srcPoint.Rotation - dstPoint.Rotation;
                if (Math.Abs(delta) <= 1e-9) return;
                var axis = Line.CreateBound(dstPoint.Point, dstPoint.Point + XYZ.BasisZ);
                ElementTransformUtils.RotateElement(created.Document, created.Id, axis, delta);
            }
            catch (Exception ex)
            {
                warnings.Add($"Failed to match rotation: {ex.Message}");
            }
        }

        internal static void ApplyPreviewDecorations(Document doc, View view, IList<long> elementIds, IList<PlacementPreviewLabel> labels, double focusPaddingFt, List<string> warnings)
        {
            var ogs = new OverrideGraphicSettings();
            ogs.SetProjectionLineWeight(6);
            ogs.SetProjectionLineColor(new Color(220, 32, 32));

            foreach (var id in elementIds.Where(x => x > 0).Distinct())
            {
                try { view.SetElementOverrides(ElementIdCompat.Create(id), ogs); } catch { }
            }

            var typeId = new FilteredElementCollector(doc).OfClass(typeof(TextNoteType)).FirstElementId();
            if (typeId != ElementId.InvalidElementId)
            {
                foreach (var label in labels)
                {
                    try { TextNote.Create(doc, view.Id, label.point, label.text, typeId); } catch { }
                    if (!string.IsNullOrWhiteSpace(label.secondaryText))
                    {
                        try
                        {
                            var secondaryPoint = label.point + (XYZ.BasisY * 0.35);
                            TextNote.Create(doc, view.Id, secondaryPoint, label.secondaryText, typeId);
                        }
                        catch { }
                    }
                }
            }

            foreach (var label in labels)
            {
                if (label.direction == null || label.direction.GetLength() <= 1e-9) continue;
                try
                {
                    var direction = label.direction.Normalize();
                    var length = Math.Max(0.25, Math.Min(6.0, label.directionLengthFt ?? 1.5));
                    var end = label.point + direction.Multiply(length);
                    var curve = Line.CreateBound(label.point, end);
                    doc.Create.NewDetailCurve(view, curve);
                }
                catch { }
            }

            TryApplyFocusCrop(doc, view, elementIds, focusPaddingFt, warnings);
        }

        internal static (string? path, int? widthPx, int? heightPx) ExportPlacementPreview(Document doc, View? view, IList<long> elementIds, IList<PlacementPreviewLabel> labels, int imageSize, double focusPaddingFt, List<string> warnings)
        {
            if (view == null)
            {
                warnings.Add("Preview image was requested, but no preview view was available.");
                return (null, null, null);
            }

            using (var tx = new Transaction(doc, "Placement Preview"))
            {
                tx.Start();
                ApplyPreviewDecorations(doc, view, elementIds, labels, focusPaddingFt, warnings);
                tx.Commit();
            }

            var folder = SelectionUtil.EnsureDefaultSelectionCaptureFolder("");
            var stem = $"Revit_{ElementIdCompat.GetValue(view.Id)}_{Guid.NewGuid():N}_placement_preview";
            var path = SelectionUtil.ExportViewImage(doc, view, imageSize, folder, stem);
            var (widthPx, heightPx) = SelectionUtil.ReadImageSize(path);
            return (path, widthPx, heightPx);
        }

        private static void TryApplyFocusCrop(Document doc, View view, IList<long> focusElementIds, double paddingFt, List<string> warnings)
        {
            if (focusElementIds == null || focusElementIds.Count == 0) return;
            if (view.ViewType == ViewType.DrawingSheet)
            {
                warnings.Add("Preview focus crop skipped because sheet views do not support crop-box focusing.");
                return;
            }

            BoundingBoxXYZ? union = null;
            foreach (var id in focusElementIds.Where(x => x > 0).Distinct())
            {
                var e = doc.GetElement(ElementIdCompat.Create(id));
                if (e == null) continue;
                BoundingBoxXYZ? bb = null;
                try { bb = e.get_BoundingBox(view); } catch { bb = null; }
                if (bb == null) continue;

                if (union == null)
                {
                    union = new BoundingBoxXYZ { Min = bb.Min, Max = bb.Max };
                }
                else
                {
                    union.Min = new XYZ(Math.Min(union.Min.X, bb.Min.X), Math.Min(union.Min.Y, bb.Min.Y), Math.Min(union.Min.Z, bb.Min.Z));
                    union.Max = new XYZ(Math.Max(union.Max.X, bb.Max.X), Math.Max(union.Max.Y, bb.Max.Y), Math.Max(union.Max.Z, bb.Max.Z));
                }
            }

            if (union == null) return;
            var pad = Math.Max(0.0, Math.Min(1000.0, paddingFt));
            var newBox = new BoundingBoxXYZ
            {
                Transform = view.CropBox?.Transform ?? Transform.Identity,
                Min = new XYZ(union.Min.X - pad, union.Min.Y - pad, union.Min.Z - pad),
                Max = new XYZ(union.Max.X + pad, union.Max.Y + pad, union.Max.Z + pad)
            };

            try
            {
                view.CropBoxActive = true;
                view.CropBoxVisible = false;
                view.CropBox = newBox;
            }
            catch (Exception ex)
            {
                warnings.Add("Preview focus crop failed: " + ex.Message);
            }
        }
    }

    public class ResolveRoomWallHandler : IRequestHandler
    {
        public sealed class Params
        {
            public long? roomId { get; set; }
            public string? roomNumber { get; set; }
            public long? viewId { get; set; }
            public string side { get; set; } = "";
            public int? maxWalls { get; set; } = 5;
            public bool includeSegments { get; set; } = true;
        }

        public Task<object> Handle(UIApplication app, string jsonData)
        {
            var p = string.IsNullOrWhiteSpace(jsonData) ? new Params() : JsonSerializer.Deserialize<Params>(jsonData) ?? new Params();
            var uidoc = app.ActiveUIDocument ?? throw new InvalidOperationException("No active UI document.");
            var doc = uidoc.Document;
            var view = HostedPlacementUtil.ResolveView(doc, uidoc.ActiveView, p.viewId) ?? throw new InvalidOperationException("View not found.");
            var spatial = HostedPlacementUtil.FindSpatialElement(doc, p.roomId, p.roomNumber) ?? throw new InvalidOperationException("Room/space not found.");
            var side = HostedPlacementUtil.NormalizeWallSide(p.side);
            if (side != "left" && side != "right" && side != "top" && side != "bottom")
                throw new InvalidOperationException("side must be left|right|top|bottom (or cardinal alias).");

            var walls = HostedPlacementUtil.ResolveRoomWalls(doc, spatial.element, view, side, Math.Max(1, Math.Min(20, p.maxWalls ?? 5)));
            return Task.FromResult<object>(new
            {
                status = "Ok",
                room = HostedPlacementUtil.BuildResolvedSpatialPayload(spatial, side),
                view = new { id = ElementIdCompat.GetValue(view.Id), name = view.Name, type = view.ViewType.ToString() },
                requestedSide = side,
                count = walls.Count,
                walls = walls.Select((wall, index) => new
                {
                    rank = index + 1,
                    hostElementId = wall.hostElementId,
                    boundaryElementId = wall.boundaryElementId > 0 ? wall.boundaryElementId : wall.hostElementId,
                    linkedElementId = wall.linkedElementId,
                    name = wall.boundaryElement?.Name ?? wall.hostElement?.Name,
                    category = wall.boundaryElement?.Category?.Name ?? wall.hostElement?.Category?.Name,
                    boundaryBuiltInCategory = wall.boundaryElement?.Category?.BuiltInCategory.ToString() ?? wall.hostElement?.Category?.BuiltInCategory.ToString(),
                    boundaryKind = wall.boundaryElement?.GetType().Name,
                    hostName = wall.hostElement?.Name,
                    hostCategory = wall.hostElement?.Category?.Name,
                    hostBuiltInCategory = wall.hostElement?.Category?.BuiltInCategory.ToString(),
                    hostKind = wall.hostElement is RevitLinkInstance ? nameof(RevitLinkInstance) : wall.wall != null ? nameof(Wall) : wall.hostElement?.GetType().Name,
                    boundaryLengthFt = wall.boundaryLengthFt,
                    midpoint = HostedPlacementUtil.BuildVector(wall.midpoint),
                    tangent = HostedPlacementUtil.BuildVector(wall.tangent),
                    projectedRoomPoint = HostedPlacementUtil.BuildVector(wall.projectedRoomPoint),
                    interiorDirection = HostedPlacementUtil.BuildVector(wall.interiorDirection),
                    supportsPlacement = wall.supportsPlacement,
                    placementHost = HostedPlacementUtil.BuildPlacementHostPayload(wall.hostElement),
                    hostContext = HostedPlacementUtil.BuildRoomWallHostContextPayload(wall),
                    wallPlacement = HostedPlacementUtil.BuildRoomWallPlacementPayload(wall),
                    requiresExplicitPointXyz = wall.hostElement is RevitLinkInstance,
                    linkedHost = HostedPlacementUtil.BuildResolvedLinkHostPayload(wall),
                    segments = p.includeSegments ? wall.segments : null
                }).ToList()
            });
        }
    }

    public class PickCandidateClusterHandler : IRequestHandler
    {
        public sealed class Params
        {
            public string frameId { get; set; } = "";
            public int xPx { get; set; }
            public int yPx { get; set; }
            public List<string>? includeCategories { get; set; }
            public List<string>? excludeCategories { get; set; }
            public List<string>? hostCategories { get; set; }
            public long? roomId { get; set; }
            public string? roomNumber { get; set; }
            public string? roomSide { get; set; }
            public double? searchRadiusFt { get; set; } = 8.0;
            public int? maxTargets { get; set; } = 6;
            public int? maxHosts { get; set; } = 6;
            public bool preferHostedTargets { get; set; } = true;
        }

        public Task<object> Handle(UIApplication app, string jsonData)
        {
            var p = string.IsNullOrWhiteSpace(jsonData) ? new Params() : JsonSerializer.Deserialize<Params>(jsonData) ?? new Params();
            if (string.IsNullOrWhiteSpace(p.frameId)) throw new InvalidOperationException("frameId is required.");
            if (!FrameStore.TryGet(p.frameId, out var frame) || frame == null) throw new InvalidOperationException("Unknown or expired frameId.");

            var uidoc = app.ActiveUIDocument ?? throw new InvalidOperationException("No active UI document.");
            var doc = uidoc.Document;
            var view = doc.GetElement(ElementIdCompat.Create(frame.viewId)) as View ?? throw new InvalidOperationException("View not found.");
            var pickPoint = SelectionUtil.PixelToModel(p.xPx, p.yPx, frame.widthPx, frame.heightPx, frame.topLeft, frame.topRight, frame.bottomLeft);
            var radiusFt = Math.Max(0.5, Math.Min(200.0, p.searchRadiusFt ?? 8.0));
            var maxTargets = Math.Max(1, Math.Min(20, p.maxTargets ?? 6));
            var maxHosts = Math.Max(1, Math.Min(20, p.maxHosts ?? 6));
            var spatial = HostedPlacementUtil.FindSpatialElement(doc, p.roomId, p.roomNumber);
            var warnings = new List<string>();
            var requestedSide = HostedPlacementUtil.NormalizeWallSide(p.roomSide);

            var hostCategories = (p.hostCategories != null && p.hostCategories.Count > 0) ? p.hostCategories : new List<string> { "OST_Walls" };
            var hosts = HostedPlacementUtil.FindNearbyHosts(doc, view, pickPoint, hostCategories, radiusFt, spatial?.element, requestedSide, maxHosts * 3);
            var recommendedHost = hosts.FirstOrDefault(x => x.onRequestedRoomSide && x.supportsPlacement)
                ?? hosts.FirstOrDefault(x => x.supportsPlacement)
                ?? hosts.FirstOrDefault(x => x.onRequestedRoomSide)
                ?? hosts.FirstOrDefault();
            var recommendedHostId = recommendedHost != null ? ElementIdCompat.GetValue(recommendedHost.element.Id) : (long?)null;

            SelectionUtil.TryParseBuiltInCategories(p.includeCategories, out var includeBics, out var invalidInclude);
            var includeTokens = new HashSet<string>((p.includeCategories ?? new List<string>()).Where(x => !string.IsNullOrWhiteSpace(x)), StringComparer.OrdinalIgnoreCase);
            var excludeTokens = new HashSet<string>((p.excludeCategories ?? new List<string>()).Where(x => !string.IsNullOrWhiteSpace(x)), StringComparer.OrdinalIgnoreCase);
            if (invalidInclude.Count > 0)
                warnings.Add("Unrecognized includeCategories tokens were matched by exact category name only when possible: " + string.Join(", ", invalidInclude));

            FilteredElementCollector collector;
            try { collector = new FilteredElementCollector(doc, view.Id).WhereElementIsNotElementType(); }
            catch { collector = new FilteredElementCollector(doc).WhereElementIsNotElementType(); }
            if (includeBics.Count > 0)
            {
                collector = collector.WherePasses(new ElementMulticategoryFilter(includeBics.Select(x => ElementIdCompat.Create((long)x)).ToList()));
            }

            var rankedTargets = collector
                .Cast<Element>()
                .Select(element =>
                {
                    var catToken = SelectionUtil.GetCategoryToken(element) ?? element.Category?.Name ?? "";
                    if (includeTokens.Count > 0 && !includeTokens.Contains(catToken) && !includeTokens.Contains(element.Category?.Name ?? "") && !includeTokens.Contains(element.Category?.BuiltInCategory.ToString() ?? ""))
                        return null;
                    if (excludeTokens.Contains(catToken) || excludeTokens.Contains(element.Category?.Name ?? "") || excludeTokens.Contains(element.Category?.BuiltInCategory.ToString() ?? ""))
                        return null;

                    var point = HostedPlacementUtil.TryGetElementPoint(element);
                    if (point == null) return null;
                    var distanceFt = HostedPlacementUtil.ViewPlaneDistanceFt(view, point, pickPoint);
                    if (distanceFt > radiusFt) return null;
                    if (spatial?.element != null && !HostedPlacementUtil.TryIsPointInSpatial(spatial.element, point)) return null;

                    var hostElement = (element as FamilyInstance)?.Host;
                    var hostId = hostElement != null ? ElementIdCompat.GetValue(hostElement.Id) : 0L;
                    var hostPlacementSupported = hostElement == null || HostedPlacementUtil.IsSupportedPlacementHost(hostElement);
                    var hostMatch = recommendedHostId.HasValue && hostId == recommendedHostId.Value;
                    var sideMatch = hosts.Any(x => x.onRequestedRoomSide && ElementIdCompat.GetValue(x.element.Id) == hostId);
                    var elementSpatial = SpatialIntentUtils.GetSpatialElement(doc, element);
                    var score = (radiusFt - distanceFt)
                        + (hostMatch ? 6.0 : 0.0)
                        + (sideMatch ? 3.0 : 0.0)
                        + (p.preferHostedTargets && hostId > 0 ? 1.0 : 0.0)
                        - (hostPlacementSupported ? 0.0 : 2.5);

                    HostedPlacementUtil.TryGetTypeInfo(doc, element, out var typeId, out var typeName, out var familyName);
                    return new
                    {
                        elementId = ElementIdCompat.GetValue(element.Id),
                        uniqueId = element.UniqueId,
                        category = element.Category?.Name,
                        builtInCategory = element.Category?.BuiltInCategory.ToString(),
                        categoryToken = catToken,
                        name = element.Name,
                        familyName,
                        typeId,
                        typeName,
                        hostId = hostId > 0 ? hostId : (long?)null,
                        hostCategory = hostElement?.Category?.Name,
                        hostBuiltInCategory = hostElement?.Category?.BuiltInCategory.ToString(),
                        hostPlacementSupported,
                        roomNumber = SpatialIntentUtils.GetSpatialNumber(elementSpatial),
                        spatialKind = SpatialIntentUtils.GetSpatialKind(elementSpatial),
                        point = HostedPlacementUtil.BuildVector(point),
                        distanceFt,
                        score,
                        onRecommendedHost = hostMatch,
                        onRequestedRoomSide = sideMatch
                    };
                })
                .Where(x => x != null)
                .OrderByDescending(x => x!.score)
                .ThenBy(x => x!.distanceFt)
                .Take(maxTargets)
                .ToList();

            var rankedHosts = hosts
                .Take(maxHosts)
                .Select((host, index) => new
                {
                    rank = index + 1,
                    elementId = ElementIdCompat.GetValue(host.element.Id),
                    category = host.element.Category?.Name,
                    builtInCategory = host.element.Category?.BuiltInCategory.ToString(),
                    name = host.element.Name,
                    distanceFt = host.distanceFt,
                    onRequestedRoomSide = host.onRequestedRoomSide,
                    supportsPlacement = host.supportsPlacement,
                    point = HostedPlacementUtil.BuildVector(host.point),
                    projectedPointOnHost = HostedPlacementUtil.BuildVector(host.projectedPointOnHost),
                    hostTangent = HostedPlacementUtil.BuildVector(host.hostTangent),
                    hostOffsetFt = host.hostOffsetFt
                })
                .ToList();

            var recommendedExemplar = rankedTargets.FirstOrDefault(x => x!.hostPlacementSupported) ?? rankedTargets.FirstOrDefault();
            string? emptyReason = null;
            if (spatial == null && (!p.roomId.HasValue || p.roomId.Value <= 0) && !string.IsNullOrWhiteSpace(p.roomNumber))
                emptyReason = "requested_spatial_not_resolved";
            else if (!string.IsNullOrWhiteSpace(requestedSide) && !hosts.Any(x => x.onRequestedRoomSide))
                emptyReason = "no_host_candidates_on_requested_side";
            else if (rankedTargets.Count == 0)
                emptyReason = "no_target_candidates_within_view_plane_radius";
            object suggestedNext = rankedTargets.Count > 0
                ? new { action = "/revit/get-placement-context", elementId = recommendedExemplar?.elementId }
                : new { action = "/revit/get-element-summary", elementId = (long?)null, reason = emptyReason ?? "no_ranked_target_candidates" };

            return Task.FromResult<object>(new
            {
                status = "Ok",
                frameId = p.frameId,
                view = new { id = frame.viewId, name = frame.viewName, type = frame.viewType },
                pickPoint = new { xPx = p.xPx, yPx = p.yPx, model = new { x = pickPoint.X, y = pickPoint.Y, z = pickPoint.Z } },
                room = HostedPlacementUtil.BuildResolvedSpatialPayload(spatial, requestedSide),
                recommendedExemplarElementId = recommendedExemplar?.elementId,
                recommendedHostElementId = recommendedHostId,
                targetCandidates = rankedTargets,
                hostCandidates = rankedHosts,
                diagnostics = new
                {
                    searchRadiusFt = radiusFt,
                    requestedSide = string.IsNullOrWhiteSpace(requestedSide) ? null : requestedSide,
                    emptyReason,
                    targetCandidateCount = rankedTargets.Count,
                    hostCandidateCount = rankedHosts.Count,
                    recommendedHostSupportsPlacement = recommendedHost?.supportsPlacement,
                    unsupportedHostCandidateIds = hosts.Where(x => !x.supportsPlacement).Select(x => ElementIdCompat.GetValue(x.element.Id)).Distinct().ToList()
                },
                suggestedNext,
                warnings
            });
        }
    }

    public class PlaceFamilyInstanceOnHostHandler : IRequestHandler
    {
        public sealed class Params
        {
            public long? sourceElementId { get; set; }
            public long? familySymbolId { get; set; }
            public string? familyName { get; set; }
            public string? symbolName { get; set; }
            public string? levelName { get; set; }
            public long hostElementId { get; set; }
            public long? linkedHostElementId { get; set; }
            public long? roomId { get; set; }
            public string? roomNumber { get; set; }
            public string? roomSide { get; set; }
            public long? referenceElementId { get; set; }
            [JsonConverter(typeof(FlexibleXyzArrayConverter))]
            public double[]? pointXyz { get; set; }
            public double? alongHostOffsetFt { get; set; }
            public double? targetChainageFt { get; set; }
            public double? targetNormalizedChainage { get; set; }
            public double? elevationFt { get; set; }
            public double? elevationDeltaFt { get; set; }
            public bool? matchOrientationFromSource { get; set; }
            public long? orientationSourceElementId { get; set; }
            public bool copyRotation { get; set; } = true;
            public bool copyFacingHandState { get; set; } = true;
            public bool? matchElectricalCircuitFromSource { get; set; }
            public bool requireElectricalCircuitMatch { get; set; } = false;
            public List<string>? parameterNamesToCopy { get; set; }
            public Dictionary<string, string>? parameterOverrides { get; set; }
            public string? distributionSystemName { get; set; }
            public ElectricalDistributionSystemDefinitionRequest? ensureDistributionSystem { get; set; }
            public bool dryRun { get; set; } = true;
            public bool includePreviewImage { get; set; } = true;
            public long? previewViewId { get; set; }
            public int? previewImageSize { get; set; } = 2200;
            public double? focusPaddingFt { get; set; } = 6.0;
            public string? label { get; set; }
        }

        public Task<object> Handle(UIApplication app, string jsonData)
        {
            var p = string.IsNullOrWhiteSpace(jsonData) ? new Params() : JsonSerializer.Deserialize<Params>(jsonData) ?? new Params();
            if (p.hostElementId <= 0) throw new InvalidOperationException("hostElementId is required.");

            var uidoc = app.ActiveUIDocument ?? throw new InvalidOperationException("No active UI document.");
            var doc = uidoc.Document;
            var sourceElement = p.sourceElementId.HasValue && p.sourceElementId.Value > 0 ? doc.GetElement(ElementIdCompat.Create(p.sourceElementId.Value)) : null;
            var referenceElement = p.referenceElementId.HasValue && p.referenceElementId.Value > 0 ? doc.GetElement(ElementIdCompat.Create(p.referenceElementId.Value)) : sourceElement;
            var orientationSource = p.orientationSourceElementId.HasValue && p.orientationSourceElementId.Value > 0
                ? doc.GetElement(ElementIdCompat.Create(p.orientationSourceElementId.Value))
                : sourceElement;
            var symbol = HostedPlacementUtil.ResolveFamilySymbol(doc, p.familySymbolId, p.familyName, p.symbolName, sourceElement)
                ?? throw new InvalidOperationException("Unable to resolve family symbol. Provide familySymbolId, symbolName, or sourceElementId.");
            var previewView = HostedPlacementUtil.ResolveView(doc, uidoc.ActiveView, p.previewViewId) ?? uidoc.ActiveView;
            var warnings = new List<string>();
            var requestedHost = doc.GetElement(ElementIdCompat.Create(p.hostElementId)) ?? throw new InvalidOperationException($"Host element {p.hostElementId} not found.");
            var host = HostedPlacementUtil.ResolveSupportedPlacementHost(doc, previewView, requestedHost, referenceElement ?? sourceElement, p.roomId, p.roomNumber, p.roomSide, warnings, "hosted placement");
            if (host is RevitLinkInstance && (!p.linkedHostElementId.HasValue || p.linkedHostElementId.Value <= 0))
                throw new InvalidOperationException("A RevitLinkInstance host requires linkedHostElementId for an exact linked wall; arbitrary linked-face fallback is not permitted.");
            var level = HostedPlacementUtil.ResolveLevel(doc, p.levelName, sourceElement, host) ?? throw new InvalidOperationException("Unable to resolve level.");
            var basePoint = (p.pointXyz != null && p.pointXyz.Length >= 3)
                ? new XYZ(p.pointXyz[0], p.pointXyz[1], p.pointXyz[2])
                : HostedPlacementUtil.TryGetElementPoint(referenceElement) ?? HostedPlacementUtil.TryGetElementPoint(host) ?? XYZ.Zero;

            RoomWallResolution? roomWall;
            if (p.linkedHostElementId.HasValue && p.linkedHostElementId.Value > 0)
            {
                if (host is not RevitLinkInstance explicitLink)
                    throw new InvalidOperationException("linkedHostElementId requires hostElementId to identify a RevitLinkInstance.");
                roomWall = HostedPlacementUtil.ResolveExplicitLinkedWallHost(explicitLink, p.linkedHostElementId.Value, basePoint, warnings)
                    ?? throw new InvalidOperationException($"Explicit linked wall {p.linkedHostElementId.Value} could not be resolved for hosted placement.");
                roomWall.faceSidePreferencePoint = basePoint;
                if (!HostedPlacementUtil.TryProjectPointToRoomWall(roomWall, basePoint, out var projectedExplicitWallPoint, out _, out _, out _))
                    throw new InvalidOperationException($"Requested point could not be projected onto explicit linked wall {p.linkedHostElementId.Value}.");
                basePoint = new XYZ(projectedExplicitWallPoint.X, projectedExplicitWallPoint.Y, basePoint.Z);
            }
            else
            {
                roomWall = HostedPlacementUtil.ResolveRoomWallForHost(doc, previewView, host, p.roomId, p.roomNumber, p.roomSide)
                    ?? HostedPlacementUtil.ResolveLinkedFaceHostFallback(doc, host, sourceElement as FamilyInstance);
            }

            if ((p.targetChainageFt.HasValue || p.targetNormalizedChainage.HasValue) && host is Wall chainageWall)
            {
                var wallLength = Math.Max(0.0, (chainageWall.Location as LocationCurve)?.Curve?.Length ?? 0.0);
                var targetChainage = p.targetChainageFt ?? ((p.targetNormalizedChainage ?? 0.0) * wallLength);
                var chainagePoint = HostedPlacementUtil.TryPointAtChainageOnWall(chainageWall, targetChainage);
                if (chainagePoint != null) basePoint = chainagePoint;
                else warnings.Add("targetChainageFt/targetNormalizedChainage was provided, but wall evaluation failed. Falling back to the resolved point.");
            }
            else if ((p.targetChainageFt.HasValue || p.targetNormalizedChainage.HasValue) && host is RevitLinkInstance && roomWall != null)
            {
                var curveLength = Math.Max(0.0, roomWall.boundaryLengthFt);
                var targetChainage = p.targetChainageFt ?? ((p.targetNormalizedChainage ?? 0.0) * curveLength);
                var chainagePoint = HostedPlacementUtil.TryPointAtChainageOnRoomWall(roomWall, targetChainage);
                if (chainagePoint != null) basePoint = chainagePoint;
                else warnings.Add("targetChainageFt/targetNormalizedChainage was provided, but linked room-boundary evaluation failed. Falling back to the resolved point.");
            }
            else if (p.alongHostOffsetFt.HasValue && host is Wall hostWall)
            {
                var anchorPoint = HostedPlacementUtil.TryGetElementPoint(referenceElement) ?? basePoint;
                if (HostedPlacementUtil.TryProjectPointToWall(hostWall, anchorPoint, out var projected, out var tangent, out _, out _))
                {
                    basePoint = projected + tangent.Multiply(p.alongHostOffsetFt.Value);
                }
                else
                {
                    warnings.Add("Host-local offset was requested, but wall curve projection failed. Falling back to the resolved point.");
                }
            }
            else if (p.alongHostOffsetFt.HasValue && host is RevitLinkInstance && roomWall != null)
            {
                var anchorPoint = HostedPlacementUtil.TryGetElementPoint(referenceElement) ?? basePoint;
                if (HostedPlacementUtil.TryProjectPointToRoomWall(roomWall, anchorPoint, out var projected, out var tangent, out _, out _))
                {
                    basePoint = projected + tangent.Multiply(p.alongHostOffsetFt.Value);
                }
                else
                {
                    warnings.Add("Host-local offset was requested, but linked room-boundary projection failed. Falling back to the resolved point.");
                }
            }
            else if (p.alongHostOffsetFt.HasValue && p.pointXyz == null)
            {
                throw new InvalidOperationException("alongHostOffsetFt requires a wall host or an explicit pointXyz basis.");
            }

            var z = p.elevationFt ?? (basePoint.Z + (p.elevationDeltaFt ?? 0.0));
            var finalPoint = new XYZ(basePoint.X, basePoint.Y, z);
            string? sourceHostFaceStableReference = null;
            if (sourceElement is FamilyInstance sourceHostFamilyInstance)
            {
                try { sourceHostFaceStableReference = sourceHostFamilyInstance.HostFace?.ConvertToStableRepresentation(doc); }
                catch { }
            }
            var preferredFaceReferenceDirection = roomWall?.tangent;
            if (orientationSource is FamilyInstance orientationSourceInstance)
            {
                try
                {
                    var orientationBasisX = orientationSourceInstance.GetTransform().BasisX;
                    if (orientationBasisX != null && orientationBasisX.GetLength() > 1e-9)
                        preferredFaceReferenceDirection = orientationBasisX;
                }
                catch { }
            }
            var facePlacement = HostedPlacementUtil.TryResolveFaceHostedPlacementReference(
                host,
                roomWall,
                finalPoint,
                preferredFaceReferenceDirection,
                warnings,
                sourceHostFaceStableReference
            );
            var requiresFaceHostedPlacement = HostedPlacementUtil.RequiresLinkedFaceHostedPlacement(host, roomWall)
                || symbol.Family.FamilyPlacementType == FamilyPlacementType.WorkPlaneBased;
            if (requiresFaceHostedPlacement && facePlacement == null)
            {
                var resolutionDetail = warnings.LastOrDefault(value => value.StartsWith("Linked face placement", StringComparison.OrdinalIgnoreCase));
                throw new InvalidOperationException(
                    $"Face-hosted placement requires a resolved face reference for host {ElementIdCompat.GetValue(host.Id)}. " +
                    "Refusing to fall back to generic host placement because Revit can create an unhosted/off-room device." +
                    (string.IsNullOrWhiteSpace(resolutionDetail) ? string.Empty : $" Detail: {resolutionDetail}")
                );
            }
            var placementPointForCreate = facePlacement?.placementPoint ?? finalPoint;
            var apiPoint = facePlacement?.placementPoint ?? HostedPlacementUtil.ConvertWorldPointForHost(host, finalPoint);
            long createdId = 0;
            long? verifiedCreatedLinkedElementId = null;
            string? previewPath = null;
            int? previewWidth = null;
            int? previewHeight = null;
            HostedPlacementUtil.PlacementValidationSummary? placementValidation = null;
            var failures = new List<CapturedFailure>();
            string? transactionStatus = null;
            object? electricalDistributionSystem = null;
            object? electricalDistributionSystemPreparation = null;
            var sourceElectricalCircuit = sourceElement is FamilyInstance sourceFamilyInstance
                ? HostedPlacementUtil.BuildElectricalCircuitAuditPayload(sourceFamilyInstance)
                : null;

            void CreateOne()
            {
                electricalDistributionSystemPreparation = HostedPlacementUtil.EnsureElectricalDistributionSystem(doc, p.ensureDistributionSystem);
                if (!symbol.IsActive)
                {
                    symbol.Activate();
                    doc.Regenerate();
                }

                var created = facePlacement != null
                    ? doc.Create.NewFamilyInstance(facePlacement.faceReference, placementPointForCreate, facePlacement.referenceDirection, symbol)
                    : doc.Create.NewFamilyInstance(apiPoint, symbol, host, level, StructuralType.NonStructural);
                if (p.linkedHostElementId.HasValue && p.linkedHostElementId.Value > 0)
                {
                    doc.Regenerate();
                    var createdHostFace = created.HostFace;
                    if (createdHostFace == null || createdHostFace.ElementId != host.Id ||
                        createdHostFace.LinkedElementId == ElementId.InvalidElementId ||
                        ElementIdCompat.GetValue(createdHostFace.LinkedElementId) != p.linkedHostElementId.Value)
                    {
                        throw new InvalidOperationException(
                            $"Created instance did not retain explicit linked wall host {p.linkedHostElementId.Value}."
                        );
                    }
                    verifiedCreatedLinkedElementId = ElementIdCompat.GetValue(createdHostFace.LinkedElementId);
                }
                if (facePlacement != null) HostedPlacementUtil.ApplyResolvedLevelToFaceHostedInstance(created, level, warnings);
                if (sourceElement != null) HostedPlacementUtil.CopyParameters(sourceElement, created, p.parameterNamesToCopy, warnings);
                HostedPlacementUtil.ApplyParameterValuesStrict(created, p.parameterOverrides);
                var requestedDistributionSystemName = !string.IsNullOrWhiteSpace(p.distributionSystemName)
                    ? p.distributionSystemName
                    : p.ensureDistributionSystem?.name;
                if (!string.IsNullOrWhiteSpace(p.distributionSystemName) && p.ensureDistributionSystem != null &&
                    !string.Equals(p.distributionSystemName.Trim(), (p.ensureDistributionSystem.name ?? "").Trim(), StringComparison.OrdinalIgnoreCase))
                {
                    throw new InvalidOperationException("distributionSystemName must match ensureDistributionSystem.name when both are provided.");
                }
                electricalDistributionSystem = HostedPlacementUtil.ApplyAndAuditElectricalDistributionSystem(doc, created, requestedDistributionSystemName);
                var matchOrientation = p.matchOrientationFromSource ?? true;
                // Face-hosted creation already uses the resolved reference direction. Rotating the
                // new instance again can make Revit reject an otherwise valid linked-face placement.
                var copyRotationAfterCreate = p.copyRotation && matchOrientation && facePlacement == null;
                HostedPlacementUtil.ApplyRotationAndFlip(
                    matchOrientation ? orientationSource : sourceElement,
                    created,
                    copyRotationAfterCreate,
                    p.copyFacingHandState && matchOrientation,
                    warnings
                );
                if (p.matchElectricalCircuitFromSource ?? false)
                {
                    var circuitMatched = HostedPlacementUtil.TryMatchElectricalCircuitFromSource(
                        sourceElement,
                        created,
                        p.requireElectricalCircuitMatch,
                        warnings,
                        out var circuitDetail
                    );
                    if (!circuitMatched && p.requireElectricalCircuitMatch)
                    {
                        throw new InvalidOperationException(circuitDetail);
                    }
                    if (!string.IsNullOrWhiteSpace(circuitDetail))
                    {
                        warnings.Add(circuitDetail);
                    }
                }
                createdId = ElementIdCompat.GetValue(created.Id);
            }

            if (p.dryRun)
            {
                using (var tg = new TransactionGroup(doc, "Place Family Instance On Host (Dry Run)"))
                {
                    tg.Start();
                    using (var tx = new Transaction(doc, "Place Hosted Family"))
                    {
                        tx.Start();
                        CreateOne();
                        doc.Regenerate();
                        placementValidation = HostedPlacementUtil.ValidateCreatedPlacements(
                            app,
                            new List<long> { createdId },
                            p.roomId,
                            p.roomNumber,
                            p.roomSide,
                            warnings
                        );
                        tx.Commit();
                    }

                    if (p.includePreviewImage)
                    {
                        var previewFrame = HostedPlacementUtil.BuildHostLocalFrameData(host, roomWall, finalPoint);
                        var labels = new List<PlacementPreviewLabel>
                        {
                            new PlacementPreviewLabel
                            {
                                text = string.IsNullOrWhiteSpace(p.label) ? "planned placement" : p.label!,
                                secondaryText = HostedPlacementUtil.BuildPlacementPreviewSecondaryText(previewFrame, orientationSource),
                                point = finalPoint,
                                direction = previewFrame?.tangent,
                                directionLengthFt = 2.0
                            }
                        };
                        (previewPath, previewWidth, previewHeight) = HostedPlacementUtil.ExportPlacementPreview(
                            doc,
                            previewView,
                            new List<long> { createdId },
                            labels,
                            Math.Max(600, Math.Min(4000, p.previewImageSize ?? 2200)),
                            Math.Max(0.0, Math.Min(100.0, p.focusPaddingFt ?? 6.0)),
                            warnings
                        );
                    }

                    tg.RollBack();
                }

                return Task.FromResult<object>(new
                {
                    status = placementValidation?.valid == false ? "InvalidPreview" : "Planned",
                    dryRun = true,
                    source = sourceElement == null ? null : new
                    {
                        id = ElementIdCompat.GetValue(sourceElement.Id),
                        name = sourceElement.Name,
                        electricalCircuit = sourceElectricalCircuit
                    },
                    familySymbol = new { id = ElementIdCompat.GetValue(symbol.Id), family = symbol.FamilyName, symbol = symbol.Name },
                    host = new { id = ElementIdCompat.GetValue(host.Id), category = host.Category?.Name, name = host.Name },
                    level = new { id = ElementIdCompat.GetValue(level.Id), name = level.Name },
                    placementPoint = new { x = finalPoint.X, y = finalPoint.Y, z = finalPoint.Z },
                    apiPlacementPoint = new { x = apiPoint.X, y = apiPoint.Y, z = apiPoint.Z },
                    placementReference = facePlacement == null ? null : new
                    {
                        basis = facePlacement.basis,
                        linkedElementId = facePlacement.linkedElementId,
                        verifiedCreatedLinkedElementId,
                        faceDistanceFt = facePlacement.faceDistanceFt,
                        point = HostedPlacementUtil.BuildVector(facePlacement.placementPoint),
                        referenceDirection = HostedPlacementUtil.BuildVector(facePlacement.referenceDirection)
                    },
                    hostLocalFrame = HostedPlacementUtil.BuildHostLocalFramePayload(HostedPlacementUtil.BuildHostLocalFrameData(host, roomWall, finalPoint), orientationSource),
                    placementValidation,
                    electricalDistributionSystemPreparation,
                    electricalDistributionSystem,
                    preview = previewPath != null ? new { path = previewPath, widthPx = previewWidth, heightPx = previewHeight } : null,
                    warnings
                });
            }

            using (var tx = new Transaction(doc, "Place Family Instance On Host"))
            {
                try
                {
                    tx.Start();
                    tx.SetFailureHandlingOptions(FailureHandlingUtil.ConfigureFailureCapture(tx, failures, rollbackOnErrors: true, deleteWarnings: true));
                    CreateOne();
                    doc.Regenerate();
                    placementValidation = HostedPlacementUtil.ValidateCreatedPlacements(
                        app,
                        new List<long> { createdId },
                        p.roomId,
                        p.roomNumber,
                        p.roomSide,
                        warnings
                    );
                    if (placementValidation.valid == false)
                    {
                        tx.RollBack();
                        throw new InvalidOperationException($"Placement validation failed; transaction rolled back. {placementValidation.reason}");
                    }
                    var st = tx.Commit();
                    transactionStatus = st.ToString();
                    if (st != TransactionStatus.Committed)
                    {
                        throw new InvalidOperationException($"Placement transaction did not commit (status={transactionStatus}).");
                    }
                }
                catch
                {
                    if (tx.GetStatus() == TransactionStatus.Started) tx.RollBack();
                    throw;
                }
            }
            if (createdId <= 0 || doc.GetElement(ElementIdCompat.Create(createdId)) == null)
            {
                var failureText = failures.Count > 0
                    ? " Failures: " + string.Join("; ", failures.Select(f => $"{f.severity}: {f.message}").Where(s => !string.IsNullOrWhiteSpace(s)).Take(3))
                    : "";
                throw new InvalidOperationException($"Placement transaction returned a non-persistent element id ({createdId}). Status={transactionStatus ?? "unknown"}.{failureText}");
            }

            if (p.includePreviewImage)
            {
                using (var tg = new TransactionGroup(doc, "Place Family Instance On Host Preview"))
                {
                    tg.Start();
                    var previewFrame = HostedPlacementUtil.BuildHostLocalFrameData(host, roomWall, finalPoint);
                    var labels = new List<PlacementPreviewLabel>
                    {
                        new PlacementPreviewLabel
                        {
                            text = string.IsNullOrWhiteSpace(p.label) ? "new instance" : p.label!,
                            secondaryText = HostedPlacementUtil.BuildPlacementPreviewSecondaryText(previewFrame, orientationSource),
                            point = finalPoint,
                            direction = previewFrame?.tangent,
                            directionLengthFt = 2.0
                        }
                    };
                    (previewPath, previewWidth, previewHeight) = HostedPlacementUtil.ExportPlacementPreview(
                        doc,
                        previewView,
                        new List<long> { createdId },
                        labels,
                        Math.Max(600, Math.Min(4000, p.previewImageSize ?? 2200)),
                        Math.Max(0.0, Math.Min(100.0, p.focusPaddingFt ?? 6.0)),
                        warnings
                    );
                    tg.RollBack();
                }
            }

            var createdFamilyInstance = doc.GetElement(ElementIdCompat.Create(createdId)) as FamilyInstance;
            return Task.FromResult<object>(new
            {
                status = "Placed",
                dryRun = false,
                elementId = createdId,
                source = sourceElement == null ? null : new
                {
                    id = ElementIdCompat.GetValue(sourceElement.Id),
                    name = sourceElement.Name,
                    electricalCircuit = sourceElectricalCircuit
                },
                familySymbol = new { id = ElementIdCompat.GetValue(symbol.Id), family = symbol.FamilyName, symbol = symbol.Name },
                host = new { id = ElementIdCompat.GetValue(host.Id), category = host.Category?.Name, name = host.Name },
                level = new { id = ElementIdCompat.GetValue(level.Id), name = level.Name },
                placementPoint = new { x = finalPoint.X, y = finalPoint.Y, z = finalPoint.Z },
                apiPlacementPoint = new { x = apiPoint.X, y = apiPoint.Y, z = apiPoint.Z },
                placementReference = facePlacement == null ? null : new
                {
                    basis = facePlacement.basis,
                    linkedElementId = facePlacement.linkedElementId,
                    verifiedCreatedLinkedElementId,
                    faceDistanceFt = facePlacement.faceDistanceFt,
                    point = HostedPlacementUtil.BuildVector(facePlacement.placementPoint),
                    referenceDirection = HostedPlacementUtil.BuildVector(facePlacement.referenceDirection)
                },
                hostLocalFrame = HostedPlacementUtil.BuildHostLocalFramePayload(HostedPlacementUtil.BuildHostLocalFrameData(host, roomWall, finalPoint), orientationSource),
                placementValidation,
                transactionStatus,
                failures,
                electricalCircuit = HostedPlacementUtil.BuildElectricalCircuitAuditPayload(createdFamilyInstance),
                electricalDistributionSystemPreparation,
                electricalDistributionSystem,
                preview = previewPath != null ? new { path = previewPath, widthPx = previewWidth, heightPx = previewHeight } : null,
                warnings
            });
        }
    }

    public class CreateSimilarFromInstanceHandler : IRequestHandler
    {
        public sealed class PlacementInput
        {
            [JsonConverter(typeof(FlexibleXyzArrayConverter))]
            public double[]? pointXyz { get; set; }
            public double? alongHostOffsetFt { get; set; }
            public double? targetChainageFt { get; set; }
            public double? targetNormalizedChainage { get; set; }
            public double? elevationFt { get; set; }
            public double? elevationDeltaFt { get; set; }
            public string? label { get; set; }
        }

        public sealed class Params
        {
            public long exemplarElementId { get; set; }
            public long? hostElementId { get; set; }
            public long? roomId { get; set; }
            public string? roomNumber { get; set; }
            public string? roomSide { get; set; }
            public long? referenceElementId { get; set; }
            public List<double>? alongHostOffsetsFt { get; set; }
            public List<PlacementInput>? placements { get; set; }
            public string? levelName { get; set; }
            public bool? matchOrientationFromSource { get; set; }
            public long? orientationSourceElementId { get; set; }
            public bool copyRotation { get; set; } = true;
            public bool copyFacingHandState { get; set; } = true;
            public bool? matchElectricalCircuitFromSource { get; set; }
            public bool requireElectricalCircuitMatch { get; set; } = false;
            public bool allowExemplarOverlap { get; set; } = false;
            public List<string>? parameterNamesToCopy { get; set; }
            public Dictionary<string, string>? parameterOverrides { get; set; }
            public bool dryRun { get; set; } = true;
            public bool includePreviewImage { get; set; } = true;
            public long? previewViewId { get; set; }
            public int? previewImageSize { get; set; } = 2200;
            public double? focusPaddingFt { get; set; } = 6.0;
        }

        public Task<object> Handle(UIApplication app, string jsonData)
        {
            var p = string.IsNullOrWhiteSpace(jsonData) ? new Params() : JsonSerializer.Deserialize<Params>(jsonData) ?? new Params();
            if (p.exemplarElementId <= 0) throw new InvalidOperationException("exemplarElementId is required.");

            var uidoc = app.ActiveUIDocument ?? throw new InvalidOperationException("No active UI document.");
            var doc = uidoc.Document;
            var exemplar = doc.GetElement(ElementIdCompat.Create(p.exemplarElementId)) ?? throw new InvalidOperationException("Exemplar element not found.");
            var exemplarFi = exemplar as FamilyInstance ?? throw new InvalidOperationException("Exemplar element must be a FamilyInstance.");
            var symbol = doc.GetElement(exemplar.GetTypeId()) as FamilySymbol ?? throw new InvalidOperationException("Exemplar type is not a FamilySymbol.");
            var requestedHost = p.hostElementId.HasValue && p.hostElementId.Value > 0
                ? doc.GetElement(ElementIdCompat.Create(p.hostElementId.Value))
                : HostedPlacementUtil.ResolveFamilyInstanceHost(doc, exemplarFi);
            var orientationSource = p.orientationSourceElementId.HasValue && p.orientationSourceElementId.Value > 0
                ? doc.GetElement(ElementIdCompat.Create(p.orientationSourceElementId.Value))
                : exemplar;

            var referenceElement = p.referenceElementId.HasValue && p.referenceElementId.Value > 0
                ? doc.GetElement(ElementIdCompat.Create(p.referenceElementId.Value))
                : exemplar;
            var previewView = HostedPlacementUtil.ResolveView(doc, uidoc.ActiveView, p.previewViewId) ?? uidoc.ActiveView;
            var warnings = new List<string>();
            if (requestedHost == null) throw new InvalidOperationException("No host element was available for create-similar.");
            var host = HostedPlacementUtil.ResolveSupportedPlacementHost(doc, previewView, requestedHost, referenceElement ?? exemplar, p.roomId, p.roomNumber, p.roomSide, warnings, "create-similar");
            var level = HostedPlacementUtil.ResolveLevel(doc, p.levelName, exemplar, host) ?? throw new InvalidOperationException("Unable to resolve level.");
            var roomWall = HostedPlacementUtil.ResolveRoomWallForHost(doc, previewView, host, p.roomId, p.roomNumber, p.roomSide)
                ?? HostedPlacementUtil.ResolveLinkedFaceHostFallback(doc, host, exemplarFi);

            var requestedPlacements = new List<PlacementInput>();
            if (p.placements != null && p.placements.Count > 0) requestedPlacements.AddRange(p.placements.Where(x => x != null));
            if (requestedPlacements.Count == 0 && p.alongHostOffsetsFt != null && p.alongHostOffsetsFt.Count > 0)
            {
                requestedPlacements.AddRange(p.alongHostOffsetsFt.Select((offset, index) => new PlacementInput
                {
                    alongHostOffsetFt = offset,
                    label = $"copy {index + 1}"
                }));
            }
            if (requestedPlacements.Count == 0) requestedPlacements.Add(new PlacementInput { alongHostOffsetFt = 0.0, label = "copy 1" });

            var createdIds = new List<long>();
            var resultRows = new List<object>();
            string? previewPath = null;
            int? previewWidth = null;
            int? previewHeight = null;
            var plannedPoints = new List<XYZ>();
            HostedPlacementUtil.PlacementValidationSummary? placementValidation = null;
            var failures = new List<CapturedFailure>();
            string? transactionStatus = null;
            var exemplarPoint = HostedPlacementUtil.TryGetElementPoint(exemplar);
            var exemplarElectricalCircuit = HostedPlacementUtil.BuildElectricalCircuitAuditPayload(exemplarFi);
            var usedCopiedLinkedHostFallback = false;

            string BuildCommitFailureText()
            {
                var parts = new List<string>();
                if (failures.Count > 0)
                {
                    parts.Add("Failures: " + string.Join("; ", failures
                        .Select(f => $"{f.severity}: {f.message}")
                        .Where(s => !string.IsNullOrWhiteSpace(s))
                        .Take(5)));
                }
                if (placementValidation != null)
                {
                    parts.Add($"PlacementValidation: valid={placementValidation.valid}, reason={placementValidation.reason}");
                }
                if (warnings.Count > 0)
                {
                    parts.Add("Warnings: " + string.Join("; ", warnings.Where(s => !string.IsNullOrWhiteSpace(s)).Take(5)));
                }
                return parts.Count > 0 ? " " + string.Join(" ", parts) : "";
            }

            for (var i = 0; i < requestedPlacements.Count; i++)
            {
                var item = requestedPlacements[i];
                var basePoint = (item.pointXyz != null && item.pointXyz.Length >= 3)
                    ? new XYZ(item.pointXyz[0], item.pointXyz[1], item.pointXyz[2])
                    : HostedPlacementUtil.TryGetElementPoint(referenceElement) ?? HostedPlacementUtil.TryGetElementPoint(exemplar) ?? XYZ.Zero;

                if ((item.targetChainageFt.HasValue || item.targetNormalizedChainage.HasValue) && host is Wall chainageWall)
                {
                    var wallLength = Math.Max(0.0, (chainageWall.Location as LocationCurve)?.Curve?.Length ?? 0.0);
                    var targetChainage = item.targetChainageFt ?? ((item.targetNormalizedChainage ?? 0.0) * wallLength);
                    var chainagePoint = HostedPlacementUtil.TryPointAtChainageOnWall(chainageWall, targetChainage);
                    if (chainagePoint != null) basePoint = chainagePoint;
                    else warnings.Add($"Placement {i + 1}: target chainage projection failed; using resolved point instead.");
                }
                else if ((item.targetChainageFt.HasValue || item.targetNormalizedChainage.HasValue) && host is RevitLinkInstance && roomWall != null)
                {
                    var curveLength = Math.Max(0.0, roomWall.boundaryLengthFt);
                    var targetChainage = item.targetChainageFt ?? ((item.targetNormalizedChainage ?? 0.0) * curveLength);
                    var chainagePoint = HostedPlacementUtil.TryPointAtChainageOnRoomWall(roomWall, targetChainage);
                    if (chainagePoint != null) basePoint = chainagePoint;
                    else warnings.Add($"Placement {i + 1}: linked room-boundary chainage projection failed; using resolved point instead.");
                }
                else if (item.alongHostOffsetFt.HasValue && host is Wall hostWall)
                {
                    var anchor = HostedPlacementUtil.TryGetElementPoint(referenceElement) ?? HostedPlacementUtil.TryGetElementPoint(exemplar) ?? basePoint;
                    if (HostedPlacementUtil.TryProjectPointToWall(hostWall, anchor, out var projected, out var tangent, out _, out _))
                    {
                        basePoint = projected + tangent.Multiply(item.alongHostOffsetFt.Value);
                    }
                }
                else if (item.alongHostOffsetFt.HasValue && host is RevitLinkInstance && roomWall != null)
                {
                    var anchor = HostedPlacementUtil.TryGetElementPoint(referenceElement) ?? HostedPlacementUtil.TryGetElementPoint(exemplar) ?? basePoint;
                    if (HostedPlacementUtil.TryProjectPointToRoomWall(roomWall, anchor, out var projected, out var tangent, out _, out _))
                    {
                        basePoint = projected + tangent.Multiply(item.alongHostOffsetFt.Value);
                    }
                    else
                    {
                        warnings.Add($"Placement {i + 1}: linked room-boundary offset projection failed; using resolved point instead.");
                    }
                }
                else if (item.alongHostOffsetFt.HasValue && item.pointXyz == null)
                {
                    throw new InvalidOperationException("alongHostOffsetFt requires a wall host or an explicit pointXyz basis.");
                }

                var z = item.elevationFt ?? (basePoint.Z + (item.elevationDeltaFt ?? 0.0));
                var finalPoint = new XYZ(basePoint.X, basePoint.Y, z);
                if (!p.allowExemplarOverlap && exemplarPoint != null && exemplarPoint.DistanceTo(finalPoint) <= 0.05)
                    throw new InvalidOperationException("Create-similar placement resolves to the exemplar insertion point. Provide a nonzero offset, targetChainageFt, or explicit pointXyz, or set allowExemplarOverlap=true.");
                if (plannedPoints.Any(existing => existing.DistanceTo(finalPoint) <= 0.05))
                    throw new InvalidOperationException("Planned placements resolve to the same world point. Provide explicit pointXyz values or distinct offsets.");
                plannedPoints.Add(finalPoint);
            }

            void CreateRows()
            {
                if (!symbol.IsActive)
                {
                    symbol.Activate();
                    doc.Regenerate();
                }

                for (var i = 0; i < requestedPlacements.Count; i++)
                {
                    var item = requestedPlacements[i];
                    var finalPoint = plannedPoints[i];
                    var facePlacement = HostedPlacementUtil.TryResolveFaceHostedPlacementReference(
                        host,
                        roomWall,
                        finalPoint,
                        roomWall?.tangent,
                        warnings
                    );
                    var canCopyLinkedHostedExemplar = facePlacement == null &&
                        host is RevitLinkInstance &&
                        exemplarPoint != null &&
                        HostedPlacementUtil.ResolveFamilyInstanceHost(doc, exemplarFi)?.Id == host.Id;
                    if (HostedPlacementUtil.RequiresLinkedFaceHostedPlacement(host, roomWall) && facePlacement == null && !canCopyLinkedHostedExemplar)
                        throw new InvalidOperationException($"Linked-wall hosted placement requires a resolved face reference for linked element {roomWall?.linkedElementId} or a hosted exemplar that can be copied without losing its host.");
                    var placementPointForCreate = facePlacement?.placementPoint ?? finalPoint;
                    var apiPoint = facePlacement?.placementPoint ?? HostedPlacementUtil.ConvertWorldPointForHost(host, finalPoint);
                    var copiedLinkedHostedExemplar = false;
                    FamilyInstance created;
                    if (facePlacement != null)
                    {
                        created = doc.Create.NewFamilyInstance(facePlacement.faceReference, placementPointForCreate, facePlacement.referenceDirection, symbol);
                    }
                    else if (canCopyLinkedHostedExemplar)
                    {
                        var copiedIds = ElementTransformUtils.CopyElement(doc, exemplar.Id, finalPoint - exemplarPoint!);
                        created = copiedIds.Select(id => doc.GetElement(id)).OfType<FamilyInstance>().FirstOrDefault()
                            ?? throw new InvalidOperationException("Copying the linked-face hosted exemplar did not produce a FamilyInstance.");
                        doc.Regenerate();
                        if (HostedPlacementUtil.ResolveFamilyInstanceHost(doc, created)?.Id != host.Id)
                            throw new InvalidOperationException("Copying the linked-face hosted exemplar did not preserve its RevitLinkInstance host.");
                        copiedLinkedHostedExemplar = true;
                        usedCopiedLinkedHostFallback = true;
                        apiPoint = finalPoint;
                    }
                    else
                    {
                        created = doc.Create.NewFamilyInstance(apiPoint, symbol, host, level, StructuralType.NonStructural);
                    }
                    HostedPlacementUtil.CopyParameters(exemplar, created, p.parameterNamesToCopy, warnings);
                    HostedPlacementUtil.ApplyParameterValues(created, p.parameterOverrides, warnings);
                    var matchOrientation = p.matchOrientationFromSource ?? true;
                    if (facePlacement == null && !copiedLinkedHostedExemplar)
                    {
                        HostedPlacementUtil.ApplyRotationAndFlip(
                            matchOrientation ? orientationSource : exemplar,
                            created,
                            p.copyRotation && matchOrientation,
                            p.copyFacingHandState && matchOrientation,
                            warnings
                        );
                    }
                    else if (facePlacement != null && matchOrientation && (p.copyRotation || p.copyFacingHandState))
                    {
                        warnings.Add("Skipped post-placement rotate/flip because the face-hosted placement reference already defines orientation; forcing rotation can make Revit roll back linked-face placements.");
                    }
                    if (p.matchElectricalCircuitFromSource ?? false)
                    {
                        var circuitMatched = HostedPlacementUtil.TryMatchElectricalCircuitFromSource(
                            exemplar,
                            created,
                            p.requireElectricalCircuitMatch,
                            warnings,
                            out var circuitDetail
                        );
                        if (!circuitMatched && p.requireElectricalCircuitMatch)
                        {
                            throw new InvalidOperationException(circuitDetail);
                        }
                        if (!string.IsNullOrWhiteSpace(circuitDetail))
                        {
                            warnings.Add(circuitDetail);
                        }
                    }
                    var createdId = ElementIdCompat.GetValue(created.Id);
                    createdIds.Add(createdId);
                    var frame = HostedPlacementUtil.BuildHostLocalFrameData(host, roomWall, finalPoint);
                    var framePayload = HostedPlacementUtil.BuildHostLocalFramePayload(frame, matchOrientation ? orientationSource : exemplar);
                    object? placementReferencePayload = facePlacement != null
                        ? new
                        {
                            basis = facePlacement.basis,
                            linkedElementId = facePlacement.linkedElementId,
                            faceDistanceFt = facePlacement.faceDistanceFt,
                            point = HostedPlacementUtil.BuildVector(facePlacement.placementPoint),
                            referenceDirection = HostedPlacementUtil.BuildVector(facePlacement.referenceDirection)
                        }
                        : copiedLinkedHostedExemplar
                            ? new
                            {
                                basis = "copied_linked_face_host",
                                linkedElementId = roomWall?.linkedElementId,
                                faceDistanceFt = 0.0,
                                point = HostedPlacementUtil.BuildVector(finalPoint),
                                referenceDirection = HostedPlacementUtil.BuildVector(roomWall?.tangent)
                            }
                            : null;
                    resultRows.Add(new
                    {
                        index = i,
                        elementId = p.dryRun ? (long?)null : createdId,
                        temporaryElementId = createdId,
                        placementPoint = new { x = finalPoint.X, y = finalPoint.Y, z = finalPoint.Z },
                        apiPlacementPoint = new { x = apiPoint.X, y = apiPoint.Y, z = apiPoint.Z },
                        placementReference = placementReferencePayload,
                        alongHostOffsetFt = item.alongHostOffsetFt,
                        targetChainageFt = item.targetChainageFt,
                        targetNormalizedChainage = item.targetNormalizedChainage,
                        hostLocalFrame = framePayload,
                        electricalCircuit = HostedPlacementUtil.BuildElectricalCircuitAuditPayload(created),
                        label = item.label
                    });
                }
            }

            void VerifyCopiedLinkedHostFallback()
            {
                if (!usedCopiedLinkedHostFallback) return;
                if (!(host is RevitLinkInstance linkHost))
                    throw new InvalidOperationException("Copied linked-host fallback requires a RevitLinkInstance host.");
                if (createdIds.Count != plannedPoints.Count)
                    throw new InvalidOperationException("Copied linked-host fallback verification could not pair every created element with its requested point.");

                for (var i = 0; i < createdIds.Count; i++)
                {
                    var created = doc.GetElement(ElementIdCompat.Create(createdIds[i])) as FamilyInstance
                        ?? throw new InvalidOperationException($"Copied linked-host fallback element {createdIds[i]} is missing or is not a FamilyInstance.");
                    var createdHost = HostedPlacementUtil.ResolveFamilyInstanceHost(doc, created);
                    if (createdHost?.Id != linkHost.Id)
                        throw new InvalidOperationException($"Copied linked-host fallback element {createdIds[i]} did not preserve RevitLinkInstance host {ElementIdCompat.GetValue(linkHost.Id)}.");
                    var actualPoint = HostedPlacementUtil.TryGetElementPoint(created)
                        ?? throw new InvalidOperationException($"Copied linked-host fallback element {createdIds[i]} has no verifiable insertion point.");
                    var distance = actualPoint.DistanceTo(plannedPoints[i]);
                    if (distance > 0.05)
                        throw new InvalidOperationException($"Copied linked-host fallback element {createdIds[i]} is {distance:0.###} ft from its requested point; maximum is 0.05 ft.");
                }

                warnings.Add("The linked model is unloaded, so linked room/side evidence is unavailable. Verified the copied instance by exact RevitLinkInstance host and requested world point instead.");
            }

            HostedPlacementUtil.PlacementValidationSummary ValidateRows()
            {
                VerifyCopiedLinkedHostFallback();
                return HostedPlacementUtil.ValidateCreatedPlacements(
                    app,
                    createdIds,
                    usedCopiedLinkedHostFallback ? null : p.roomId,
                    usedCopiedLinkedHostFallback ? null : p.roomNumber,
                    usedCopiedLinkedHostFallback ? null : p.roomSide,
                    warnings
                );
            }

            if (p.dryRun)
            {
                using (var tg = new TransactionGroup(doc, "Create Similar From Instance (Dry Run)"))
                {
                    tg.Start();
                    using (var tx = new Transaction(doc, "Create Similar From Instance"))
                    {
                        tx.Start();
                        CreateRows();
                        doc.Regenerate();
                        placementValidation = ValidateRows();
                        tx.Commit();
                    }

                    if (p.includePreviewImage && createdIds.Count > 0)
                    {
                        var labels = requestedPlacements.Select((item, index) =>
                        {
                            var previewFrame = HostedPlacementUtil.BuildHostLocalFrameData(host, roomWall, plannedPoints[index]);
                            return new PlacementPreviewLabel
                            {
                                text = string.IsNullOrWhiteSpace(item.label) ? $"copy {index + 1}" : item.label!,
                                secondaryText = HostedPlacementUtil.BuildPlacementPreviewSecondaryText(
                                    previewFrame,
                                    p.matchOrientationFromSource ?? true ? orientationSource : exemplar
                                ),
                                point = plannedPoints[index],
                                direction = previewFrame?.tangent,
                                directionLengthFt = 2.0
                            };
                        }).ToList();
                        (previewPath, previewWidth, previewHeight) = HostedPlacementUtil.ExportPlacementPreview(
                            doc,
                            previewView,
                            createdIds,
                            labels,
                            Math.Max(600, Math.Min(4000, p.previewImageSize ?? 2200)),
                            Math.Max(0.0, Math.Min(100.0, p.focusPaddingFt ?? 6.0)),
                            warnings
                        );
                    }

                    tg.RollBack();
                }

                return Task.FromResult<object>(new
                {
                    status = placementValidation?.valid == false ? "InvalidPreview" : "Planned",
                    dryRun = true,
                    exemplar = new { id = ElementIdCompat.GetValue(exemplar.Id), name = exemplar.Name, electricalCircuit = exemplarElectricalCircuit },
                    host = new { id = ElementIdCompat.GetValue(host.Id), category = host.Category?.Name, name = host.Name },
                    familySymbol = new { id = ElementIdCompat.GetValue(symbol.Id), family = symbol.FamilyName, symbol = symbol.Name },
                    level = new { id = ElementIdCompat.GetValue(level.Id), name = level.Name },
                    placements = resultRows,
                    placementValidation,
                    preview = previewPath != null ? new { path = previewPath, widthPx = previewWidth, heightPx = previewHeight } : null,
                    warnings
                });
            }

            using (var tx = new Transaction(doc, "Create Similar From Instance"))
            {
                try
                {
                    tx.Start();
                    tx.SetFailureHandlingOptions(FailureHandlingUtil.ConfigureFailureCapture(tx, failures, rollbackOnErrors: true, deleteWarnings: true));
                    CreateRows();
                    doc.Regenerate();
                    placementValidation = ValidateRows();
                    if (placementValidation.valid == false)
                    {
                        tx.RollBack();
                        throw new InvalidOperationException($"Placement validation failed; transaction rolled back. {placementValidation.reason}");
                    }
                    var st = tx.Commit();
                    transactionStatus = st.ToString();
                    if (st != TransactionStatus.Committed)
                    {
                        throw new InvalidOperationException($"Create-similar transaction did not commit (status={transactionStatus}).{BuildCommitFailureText()}");
                    }
                }
                catch
                {
                    if (tx.GetStatus() == TransactionStatus.Started) tx.RollBack();
                    throw;
                }
            }
            var missingCreatedIds = createdIds
                .Where(id => id <= 0 || doc.GetElement(ElementIdCompat.Create(id)) == null)
                .ToList();
            if (missingCreatedIds.Count > 0)
            {
                var failureText = failures.Count > 0
                    ? " Failures: " + string.Join("; ", failures.Select(f => $"{f.severity}: {f.message}").Where(s => !string.IsNullOrWhiteSpace(s)).Take(3))
                    : "";
                throw new InvalidOperationException($"Create-similar transaction returned non-persistent element id(s): {string.Join(",", missingCreatedIds)}. Status={transactionStatus ?? "unknown"}.{failureText}");
            }

            if (p.includePreviewImage && createdIds.Count > 0)
            {
                using (var tg = new TransactionGroup(doc, "Create Similar From Instance Preview"))
                {
                    tg.Start();
                    var labels = requestedPlacements.Select((item, index) =>
                    {
                        var previewFrame = HostedPlacementUtil.BuildHostLocalFrameData(host, roomWall, plannedPoints[index]);
                        return new PlacementPreviewLabel
                        {
                            text = string.IsNullOrWhiteSpace(item.label) ? $"copy {index + 1}" : item.label!,
                            secondaryText = HostedPlacementUtil.BuildPlacementPreviewSecondaryText(
                                previewFrame,
                                p.matchOrientationFromSource ?? true ? orientationSource : exemplar
                            ),
                            point = plannedPoints[index],
                            direction = previewFrame?.tangent,
                            directionLengthFt = 2.0
                        };
                    }).ToList();
                    (previewPath, previewWidth, previewHeight) = HostedPlacementUtil.ExportPlacementPreview(
                        doc,
                        previewView,
                        createdIds,
                        labels,
                        Math.Max(600, Math.Min(4000, p.previewImageSize ?? 2200)),
                        Math.Max(0.0, Math.Min(100.0, p.focusPaddingFt ?? 6.0)),
                        warnings
                    );
                    tg.RollBack();
                }
            }

            return Task.FromResult<object>(new
            {
                status = "Placed",
                dryRun = false,
                exemplar = new { id = ElementIdCompat.GetValue(exemplar.Id), name = exemplar.Name, electricalCircuit = exemplarElectricalCircuit },
                host = new { id = ElementIdCompat.GetValue(host.Id), category = host.Category?.Name, name = host.Name },
                familySymbol = new { id = ElementIdCompat.GetValue(symbol.Id), family = symbol.FamilyName, symbol = symbol.Name },
                level = new { id = ElementIdCompat.GetValue(level.Id), name = level.Name },
                elementIds = createdIds,
                placements = resultRows,
                placementValidation,
                transactionStatus,
                failures,
                preview = previewPath != null ? new { path = previewPath, widthPx = previewWidth, heightPx = previewHeight } : null,
                warnings
            });
        }
    }

    public class ProjectPointToHostFrameHandler : IRequestHandler
    {
        public sealed class Params
        {
            public long hostElementId { get; set; }
            public long? roomId { get; set; }
            public string? roomNumber { get; set; }
            public string? roomSide { get; set; }
            public long? viewId { get; set; }
            public double[]? pointXyz { get; set; }
            public double[]? anchorPointXyz { get; set; }
            public double? alongHostOffsetFt { get; set; }
            public double? targetChainageFt { get; set; }
            public double? targetNormalizedChainage { get; set; }
        }

        public Task<object> Handle(UIApplication app, string jsonData)
        {
            var p = string.IsNullOrWhiteSpace(jsonData) ? new Params() : JsonSerializer.Deserialize<Params>(jsonData) ?? new Params();
            if (p.hostElementId <= 0) throw new InvalidOperationException("hostElementId is required.");

            var uidoc = app.ActiveUIDocument ?? throw new InvalidOperationException("No active UI document.");
            var doc = uidoc.Document;
            var host = doc.GetElement(ElementIdCompat.Create(p.hostElementId)) ?? throw new InvalidOperationException($"Host element {p.hostElementId} not found.");
            if (!HostedPlacementUtil.IsSupportedPlacementHost(host))
                throw new InvalidOperationException($"Unsupported host element: {host.Category?.Name ?? host.GetType().Name}.");

            var view = HostedPlacementUtil.ResolveView(doc, uidoc.ActiveView, p.viewId) ?? uidoc.ActiveView;
            var roomWall = HostedPlacementUtil.ResolveRoomWallForHost(doc, view, host, p.roomId, p.roomNumber, p.roomSide);
            var warnings = new List<string>();
            XYZ? point = p.pointXyz != null && p.pointXyz.Length >= 3 ? new XYZ(p.pointXyz[0], p.pointXyz[1], p.pointXyz[2]) : null;
            XYZ? anchorPoint = p.anchorPointXyz != null && p.anchorPointXyz.Length >= 3 ? new XYZ(p.anchorPointXyz[0], p.anchorPointXyz[1], p.anchorPointXyz[2]) : point;
            XYZ? resolvedPoint = point ?? HostedPlacementUtil.TryGetElementPoint(host);

            if ((p.targetChainageFt.HasValue || p.targetNormalizedChainage.HasValue) && host is Wall chainageWall)
            {
                var wallLength = Math.Max(0.0, (chainageWall.Location as LocationCurve)?.Curve?.Length ?? 0.0);
                var targetChainage = p.targetChainageFt ?? ((p.targetNormalizedChainage ?? 0.0) * wallLength);
                resolvedPoint = HostedPlacementUtil.TryPointAtChainageOnWall(chainageWall, targetChainage);
            }
            else if ((p.targetChainageFt.HasValue || p.targetNormalizedChainage.HasValue) && host is RevitLinkInstance && roomWall != null)
            {
                var boundaryLength = Math.Max(0.0, roomWall.boundaryLengthFt);
                var targetChainage = p.targetChainageFt ?? ((p.targetNormalizedChainage ?? 0.0) * boundaryLength);
                resolvedPoint = HostedPlacementUtil.TryPointAtChainageOnRoomWall(roomWall, targetChainage);
            }
            else if (p.alongHostOffsetFt.HasValue && host is Wall offsetWall)
            {
                if (anchorPoint == null) throw new InvalidOperationException("alongHostOffsetFt requires anchorPointXyz or pointXyz.");
                if (HostedPlacementUtil.TryProjectPointToWall(offsetWall, anchorPoint, out var projected, out var tangent, out _, out _))
                    resolvedPoint = projected + tangent.Multiply(p.alongHostOffsetFt.Value);
                else
                    warnings.Add("Wall projection failed for alongHostOffsetFt. Returning the input point instead.");
            }
            else if (p.alongHostOffsetFt.HasValue && host is RevitLinkInstance && roomWall != null)
            {
                if (anchorPoint == null) throw new InvalidOperationException("alongHostOffsetFt requires anchorPointXyz or pointXyz.");
                if (HostedPlacementUtil.TryProjectPointToRoomWall(roomWall, anchorPoint, out var projected, out var tangent, out _, out _))
                    resolvedPoint = projected + tangent.Multiply(p.alongHostOffsetFt.Value);
                else
                    warnings.Add("Linked room-boundary projection failed for alongHostOffsetFt. Returning the input point instead.");
            }

            if (resolvedPoint == null)
                throw new InvalidOperationException("A point basis is required. Provide pointXyz, anchorPointXyz, or a chainage input.");

            var frame = HostedPlacementUtil.BuildHostLocalFrameData(host, roomWall, resolvedPoint);
            return Task.FromResult<object>(new
            {
                status = "Ok",
                host = HostedPlacementUtil.BuildPlacementHostPayload(host),
                roomWall = roomWall == null ? null : new
                {
                    hostElementId = roomWall.hostElementId,
                    hostContext = HostedPlacementUtil.BuildRoomWallHostContextPayload(roomWall),
                    wallPlacement = HostedPlacementUtil.BuildRoomWallPlacementPayload(roomWall)
                },
                worldPoint = new { x = resolvedPoint.X, y = resolvedPoint.Y, z = resolvedPoint.Z },
                apiPoint = new
                {
                    x = HostedPlacementUtil.ConvertWorldPointForHost(host, resolvedPoint).X,
                    y = HostedPlacementUtil.ConvertWorldPointForHost(host, resolvedPoint).Y,
                    z = HostedPlacementUtil.ConvertWorldPointForHost(host, resolvedPoint).Z
                },
                hostLocalFrame = HostedPlacementUtil.BuildHostLocalFramePayload(frame),
                warnings
            });
        }
    }

    public class AuditHostedInstancePlacementHandler : IRequestHandler
    {
        public sealed class Params
        {
            public List<long>? elementIds { get; set; }
            public long? roomId { get; set; }
            public string? roomNumber { get; set; }
            public string? roomSide { get; set; }
            public List<string>? hostCategories { get; set; }
            public double? hostSearchRadiusFt { get; set; } = 12.0;
            public int? maxNearbyHosts { get; set; } = 5;
            public double? targetChainageFt { get; set; }
            public double? targetNormalizedChainage { get; set; }
            public double[]? targetPointXyz { get; set; }
            public double? targetToleranceFt { get; set; } = 0.5;
        }

        public Task<object> Handle(UIApplication app, string jsonData)
        {
            var p = string.IsNullOrWhiteSpace(jsonData) ? new Params() : JsonSerializer.Deserialize<Params>(jsonData) ?? new Params();
            var ids = (p.elementIds ?? new List<long>()).Where(id => id > 0).Distinct().Take(64).ToList();
            if (ids.Count == 0) throw new InvalidOperationException("elementIds is required.");

            var wantRoom = HostedPlacementUtil.NormalizeNumericRoomNumber(p.roomNumber);
            var wantRoomEvidence = wantRoom.Length > 0 || (p.roomId.HasValue && p.roomId.Value > 0);
            var wantWallSide = HostedPlacementUtil.NormalizeWallSide(p.roomSide);
            var wantWallEvidence = wantWallSide.Length > 0;
            var items = new List<object>();
            var auditedIds = new List<long>();
            var validIds = new List<long>();
            var invalidIds = new List<long>();
            var offRoomIds = new List<long>();
            var offWallIds = new List<long>();
            var unsupportedIds = new List<long>();
            var missingIds = new List<long>();

            foreach (var id in ids)
            {
                object? contextResult;
                try
                {
                    contextResult = new GetPlacementContextHandler().Handle(app, JsonSerializer.Serialize(new GetPlacementContextHandler.Params
                    {
                        elementId = id,
                        hostCategories = p.hostCategories ?? new List<string> { "OST_Walls" },
                        hostSearchRadiusFt = p.hostSearchRadiusFt,
                        maxNearbyHosts = p.maxNearbyHosts,
                        pointXyz = null,
                        roomNumber = p.roomNumber,
                        roomSide = p.roomSide
                    })).Result;
                }
                catch (Exception ex)
                {
                    invalidIds.Add(id);
                    missingIds.Add(id);
                    items.Add(new
                    {
                        elementId = id,
                        status = "Error",
                        valid = false,
                        error = ex.Message
                    });
                    continue;
                }

                using var docJson = JsonDocument.Parse(JsonSerializer.Serialize(contextResult));
                var root = docJson.RootElement;
                auditedIds.Add(id);

                long? actualHostId = null;
                if (root.TryGetProperty("hostLocalFrame", out var hostLocalFrame) && hostLocalFrame.ValueKind == JsonValueKind.Object && hostLocalFrame.TryGetProperty("hostElementId", out var hostLocalFrameHostId) && hostLocalFrameHostId.TryGetInt64(out var hostLocalFrameHostValue))
                    actualHostId = hostLocalFrameHostValue;
                else if (root.TryGetProperty("placementHost", out var placementHost) && placementHost.ValueKind == JsonValueKind.Object && placementHost.TryGetProperty("id", out var placementHostId) && placementHostId.TryGetInt64(out var placementHostValue))
                    actualHostId = placementHostValue;

                var actualRoomNumber = "";
                if (root.TryGetProperty("room", out var room) && room.ValueKind == JsonValueKind.Object && room.TryGetProperty("number", out var roomNumberElement))
                    actualRoomNumber = HostedPlacementUtil.NormalizeNumericRoomNumber(roomNumberElement.GetString());

                var requestedWallHostIds = new List<long>();
                if (root.TryGetProperty("requestedRoomWalls", out var requestedRoomWalls) && requestedRoomWalls.ValueKind == JsonValueKind.Array)
                {
                    foreach (var wall in requestedRoomWalls.EnumerateArray())
                    {
                        if (wall.ValueKind == JsonValueKind.Object)
                        {
                            if (wall.TryGetProperty("hostElementId", out var hostElementId) && hostElementId.TryGetInt64(out var wallHostId) && wallHostId > 0)
                                requestedWallHostIds.Add(wallHostId);
                            else if (wall.TryGetProperty("hostContext", out var hostContext) && hostContext.ValueKind == JsonValueKind.Object && hostContext.TryGetProperty("hostElementId", out var hostContextId) && hostContextId.TryGetInt64(out var hostContextHostId) && hostContextHostId > 0)
                                requestedWallHostIds.Add(hostContextHostId);
                        }
                    }
                }

                var supportsPlacement = false;
                double? actualChainageFt = null;
                double? actualNormalizedChainage = null;
                double? actualCurveLengthFt = null;
                if (root.TryGetProperty("diagnostics", out var diagnostics) && diagnostics.ValueKind == JsonValueKind.Object &&
                    diagnostics.TryGetProperty("hostPlacementSupport", out var hostPlacementSupport) && hostPlacementSupport.ValueKind == JsonValueKind.Object &&
                    hostPlacementSupport.TryGetProperty("supported", out var supportedElement))
                {
                    supportsPlacement = supportedElement.ValueKind == JsonValueKind.True;
                }
                if (root.TryGetProperty("hostLocalFrame", out var targetFrameElement) && targetFrameElement.ValueKind == JsonValueKind.Object)
                {
                    if (targetFrameElement.TryGetProperty("chainageFt", out var chainageElement) && chainageElement.TryGetDouble(out var chainageValue))
                        actualChainageFt = chainageValue;
                    if (targetFrameElement.TryGetProperty("normalizedChainage", out var normalizedChainageElement) && normalizedChainageElement.TryGetDouble(out var normalizedValue))
                        actualNormalizedChainage = normalizedValue;
                    if (targetFrameElement.TryGetProperty("curveLengthFt", out var curveLengthElement) && curveLengthElement.TryGetDouble(out var curveLengthValue))
                        actualCurveLengthFt = curveLengthValue;
                }

                var roomEvidenceMissing = wantRoomEvidence && actualRoomNumber.Length == 0;
                var wallEvidenceMissing = wantWallEvidence && requestedWallHostIds.Count == 0;
                double? targetChainageFt = p.targetChainageFt;
                if (!targetChainageFt.HasValue && p.targetNormalizedChainage.HasValue && actualCurveLengthFt.HasValue && actualCurveLengthFt.Value > 1e-6)
                    targetChainageFt = p.targetNormalizedChainage.Value * actualCurveLengthFt.Value;
                var targetToleranceFt = Math.Max(0.0833333333, Math.Min(10.0, p.targetToleranceFt ?? 0.5));
                double? targetDistanceFt = null;
                bool? withinTargetTolerance = null;
                if (targetChainageFt.HasValue && actualChainageFt.HasValue)
                {
                    targetDistanceFt = Math.Abs(actualChainageFt.Value - targetChainageFt.Value);
                    withinTargetTolerance = targetDistanceFt.Value <= targetToleranceFt;
                }
                double? targetPointDistanceFt = null;
                bool? withinTargetPointTolerance = null;
                if (p.targetPointXyz != null && p.targetPointXyz.Length >= 3)
                {
                    JsonElement actualPointElement;
                    var hasActualPoint =
                        root.TryGetProperty("insertionPoint", out actualPointElement) ||
                        root.TryGetProperty("center", out actualPointElement);
                    if (hasActualPoint && actualPointElement.ValueKind == JsonValueKind.Object &&
                        actualPointElement.TryGetProperty("x", out var actualXElement) && actualXElement.TryGetDouble(out var actualX) &&
                        actualPointElement.TryGetProperty("y", out var actualYElement) && actualYElement.TryGetDouble(out var actualY) &&
                        actualPointElement.TryGetProperty("z", out var actualZElement) && actualZElement.TryGetDouble(out var actualZ))
                    {
                        var dx = actualX - p.targetPointXyz[0];
                        var dy = actualY - p.targetPointXyz[1];
                        var dz = actualZ - p.targetPointXyz[2];
                        targetPointDistanceFt = Math.Sqrt(dx * dx + dy * dy + dz * dz);
                        withinTargetPointTolerance = targetPointDistanceFt.Value <= targetToleranceFt;
                    }
                }
                var inRequestedRoom =
                    !wantRoomEvidence ||
                    (actualRoomNumber.Length > 0 && (wantRoom.Length == 0 || string.Equals(actualRoomNumber, wantRoom, StringComparison.OrdinalIgnoreCase)));
                var onRequestedWall =
                    !wantWallEvidence ||
                    (requestedWallHostIds.Count > 0 && actualHostId.HasValue && requestedWallHostIds.Contains(actualHostId.Value));
                var targetLocationOk =
                    (!targetChainageFt.HasValue || withinTargetTolerance == true) &&
                    (withinTargetPointTolerance == null || withinTargetPointTolerance == true);
                var valid = inRequestedRoom && onRequestedWall && supportsPlacement && targetLocationOk;
                object? electricalCircuit = null;
                if (root.TryGetProperty("electricalCircuit", out var electricalCircuitElement) && electricalCircuitElement.ValueKind == JsonValueKind.Object)
                    electricalCircuit = JsonSerializer.Deserialize<object>(electricalCircuitElement.GetRawText());

                if (valid) validIds.Add(id);
                else
                {
                    invalidIds.Add(id);
                    if (!inRequestedRoom) offRoomIds.Add(id);
                    if (!onRequestedWall) offWallIds.Add(id);
                    if (!supportsPlacement) unsupportedIds.Add(id);
                }

                items.Add(new
                {
                    elementId = id,
                    status = "Ok",
                    valid,
                    inRequestedRoom,
                    onRequestedWall,
                    roomEvidenceMissing,
                    wallEvidenceMissing,
                    requestedRoomEvidenceRequired = wantRoomEvidence,
                    requestedWallEvidenceRequired = wantWallEvidence,
                    supportsPlacement,
                    requestedRoomNumber = wantRoom.Length == 0 ? null : wantRoom,
                    requestedRoomSide = wantWallEvidence ? wantWallSide : null,
                    targetChainageFt,
                    actualChainageFt,
                    actualNormalizedChainage,
                    targetToleranceFt,
                    targetDistanceFt,
                    withinTargetTolerance,
                    targetPointXyz = p.targetPointXyz,
                    targetPointDistanceFt,
                    withinTargetPointTolerance,
                    actualRoomNumber = actualRoomNumber.Length == 0 ? null : actualRoomNumber,
                    hostElementId = actualHostId,
                    requestedWallHostIds = requestedWallHostIds.Distinct().ToList(),
                    electricalCircuit,
                    placementContext = JsonSerializer.Deserialize<object>(root.GetRawText())
                });
            }

            return Task.FromResult<object>(new
            {
                status = "Ok",
                count = ids.Count,
                auditedIds,
                validIds,
                invalidIds,
                offRoomIds,
                offWallIds,
                unsupportedIds,
                missingIds,
                items
            });
        }
    }

    public class AdjustHostedInstanceOnHostHandler : IRequestHandler
    {
        public sealed class Params
        {
            public long elementId { get; set; }
            public long? roomId { get; set; }
            public string? roomNumber { get; set; }
            public string? roomSide { get; set; }
            public long? orientationSourceElementId { get; set; }
            public long? electricalCircuitSourceElementId { get; set; }
            public bool? matchOrientationFromSource { get; set; }
            public bool matchElectricalCircuitFromSource { get; set; } = false;
            public bool requireElectricalCircuitMatch { get; set; } = false;
            public bool copyRotation { get; set; } = true;
            public bool copyFacingHandState { get; set; } = true;
            public double[]? pointXyz { get; set; }
            public double? alongHostDeltaFt { get; set; }
            public double? targetChainageFt { get; set; }
            public double? targetNormalizedChainage { get; set; }
            public double? rotateToHostRelativeDegrees { get; set; }
            public bool dryRun { get; set; } = true;
            public bool includePreviewImage { get; set; } = true;
            public long? previewViewId { get; set; }
            public int? previewImageSize { get; set; } = 2200;
            public double? focusPaddingFt { get; set; } = 6.0;
            public string? label { get; set; }
        }

        public Task<object> Handle(UIApplication app, string jsonData)
        {
            var p = string.IsNullOrWhiteSpace(jsonData) ? new Params() : JsonSerializer.Deserialize<Params>(jsonData) ?? new Params();
            if (p.elementId <= 0) throw new InvalidOperationException("elementId is required.");

            var uidoc = app.ActiveUIDocument ?? throw new InvalidOperationException("No active UI document.");
            var doc = uidoc.Document;
            var element = doc.GetElement(ElementIdCompat.Create(p.elementId)) ?? throw new InvalidOperationException($"Element {p.elementId} not found.");
            var familyInstance = element as FamilyInstance ?? throw new InvalidOperationException("elementId must reference a FamilyInstance.");
            var host = HostedPlacementUtil.ResolveFamilyInstanceHost(doc, familyInstance) ?? throw new InvalidOperationException("Hosted adjustment requires a FamilyInstance host.");
            if (!HostedPlacementUtil.IsSupportedPlacementHost(host))
                throw new InvalidOperationException($"Unsupported host element: {host.Category?.Name ?? host.GetType().Name}.");

            var previewView = HostedPlacementUtil.ResolveView(doc, uidoc.ActiveView, p.previewViewId) ?? uidoc.ActiveView;
            var roomWall = HostedPlacementUtil.ResolveRoomWallForHost(doc, previewView, host, p.roomId, p.roomNumber, p.roomSide)
                ?? HostedPlacementUtil.ResolveLinkedFaceHostFallback(doc, host, familyInstance);
            var warnings = new List<string>();
            var currentPoint = HostedPlacementUtil.TryGetElementPoint(element) ?? throw new InvalidOperationException("Unable to resolve element insertion point.");
            var currentFrame = HostedPlacementUtil.BuildHostLocalFrameData(host, roomWall, currentPoint);
            XYZ? targetPoint = p.pointXyz != null && p.pointXyz.Length >= 3 ? new XYZ(p.pointXyz[0], p.pointXyz[1], p.pointXyz[2]) : null;

            if ((p.targetChainageFt.HasValue || p.targetNormalizedChainage.HasValue) && host is Wall wallHost)
            {
                var wallLength = Math.Max(0.0, (wallHost.Location as LocationCurve)?.Curve?.Length ?? 0.0);
                var targetChainage = p.targetChainageFt ?? ((p.targetNormalizedChainage ?? 0.0) * wallLength);
                targetPoint = HostedPlacementUtil.TryPointAtChainageOnWall(wallHost, targetChainage);
            }
            else if ((p.targetChainageFt.HasValue || p.targetNormalizedChainage.HasValue) && host is RevitLinkInstance && roomWall != null)
            {
                var curveLength = Math.Max(0.0, roomWall.boundaryLengthFt);
                var targetChainage = p.targetChainageFt ?? ((p.targetNormalizedChainage ?? 0.0) * curveLength);
                targetPoint = HostedPlacementUtil.TryPointAtChainageOnRoomWall(roomWall, targetChainage);
            }
            else if (p.alongHostDeltaFt.HasValue && currentFrame != null)
            {
                var targetChainage = currentFrame.chainageFt + p.alongHostDeltaFt.Value;
                targetPoint = host is Wall wallForDelta
                    ? HostedPlacementUtil.TryPointAtChainageOnWall(wallForDelta, targetChainage)
                    : roomWall != null
                        ? HostedPlacementUtil.TryPointAtChainageOnRoomWall(roomWall, targetChainage)
                        : null;
            }

            if (targetPoint == null) targetPoint = currentPoint;
            else if (p.pointXyz == null || p.pointXyz.Length < 3)
            {
                // Host chainage is a 2D placement coordinate. Preserve the
                // instance mounting elevation unless the caller supplied an
                // explicit world point with its own Z value.
                targetPoint = new XYZ(
                    targetPoint.X,
                    targetPoint.Y,
                    HostedInstanceAdjustmentPolicy.ResolveTargetElevationFt(currentPoint.Z, targetPoint.Z, hasExplicitPoint: false)
                );
            }
            var targetFrame = HostedPlacementUtil.BuildHostLocalFrameData(host, roomWall, targetPoint);
            var orientationSource = p.orientationSourceElementId.HasValue && p.orientationSourceElementId.Value > 0
                ? doc.GetElement(ElementIdCompat.Create(p.orientationSourceElementId.Value))
                : null;
            var electricalCircuitSource = p.electricalCircuitSourceElementId.HasValue && p.electricalCircuitSourceElementId.Value > 0
                ? doc.GetElement(ElementIdCompat.Create(p.electricalCircuitSourceElementId.Value))
                : orientationSource;
            string? previewPath = null;
            int? previewWidth = null;
            int? previewHeight = null;
            string circuitActionDetail = "";
            var circuitAuditBefore = HostedPlacementUtil.BuildElectricalCircuitAuditPayload(familyInstance);
            var originalElementId = ElementIdCompat.GetValue(element.Id);
            var activeElement = element;
            var activeFamilyInstance = familyInstance;
            var usedFaceHostedReplacement = false;
            long? replacementElementId = null;
            HostedPlacementUtil.PlacementValidationSummary? placementValidation = null;

            XYZ RotateInPlan(XYZ direction, double radians)
            {
                var normalized = direction.GetLength() > 1e-9 ? direction.Normalize() : XYZ.BasisX;
                var cos = Math.Cos(radians);
                var sin = Math.Sin(radians);
                var rotated = new XYZ(
                    (normalized.X * cos) - (normalized.Y * sin),
                    (normalized.X * sin) + (normalized.Y * cos),
                    normalized.Z
                );
                return rotated.GetLength() > 1e-9 ? rotated.Normalize() : XYZ.BasisX;
            }

            XYZ ResolveReplacementReferenceDirection()
            {
                var tangent = targetFrame?.tangent != null && targetFrame.tangent.GetLength() > 1e-9
                    ? targetFrame.tangent.Normalize()
                    : XYZ.BasisX;
                if (p.rotateToHostRelativeDegrees.HasValue)
                    return RotateInPlan(tangent, (p.rotateToHostRelativeDegrees.Value * Math.PI) / 180.0);

                var sourceForOrientation = (p.matchOrientationFromSource ?? false) && orientationSource != null
                    ? orientationSource
                    : element;
                var relative = HostedPlacementUtil.TryComputeOrientationRelativeToHostRadians(sourceForOrientation, currentFrame);
                return relative.HasValue ? RotateInPlan(tangent, relative.Value) : tangent;
            }

            void ApplyAdjustment()
            {
                if (HostedInstanceAdjustmentPolicy.RequiresLinkedFaceReplacement(
                    host is RevitLinkInstance,
                    roomWall?.linkedElementId != null && roomWall.linkedElementId.Value > 0))
                {
                    var symbol = doc.GetElement(element.GetTypeId()) as FamilySymbol
                        ?? throw new InvalidOperationException("Hosted replacement requires a FamilySymbol type.");
                    var facePlacement = HostedPlacementUtil.TryResolveFaceHostedPlacementReference(
                        host,
                        roomWall,
                        targetPoint,
                        ResolveReplacementReferenceDirection(),
                        warnings
                    ) ?? throw new InvalidOperationException(
                        $"Unable to resolve a linked-face placement reference for linked element {roomWall.linkedElementId.Value}."
                    );

                    if (!symbol.IsActive)
                    {
                        symbol.Activate();
                        doc.Regenerate();
                    }

                    var replacement = doc.Create.NewFamilyInstance(
                        facePlacement.faceReference,
                        facePlacement.placementPoint,
                        facePlacement.referenceDirection,
                        symbol
                    );
                    HostedPlacementUtil.CopyParameters(element, replacement, new[] { "Mark", "Comments" }, warnings);

                    var circuitMatched = HostedPlacementUtil.TryMatchElectricalCircuitFromSource(
                        element,
                        replacement,
                        p.requireElectricalCircuitMatch,
                        warnings,
                        out var replacementCircuitDetail
                    );
                    circuitActionDetail = replacementCircuitDetail;
                    if (!circuitMatched && p.requireElectricalCircuitMatch)
                        throw new InvalidOperationException(replacementCircuitDetail);
                    if (!string.IsNullOrWhiteSpace(replacementCircuitDetail)) warnings.Add(replacementCircuitDetail);

                    doc.Regenerate();
                    replacementElementId = ElementIdCompat.GetValue(replacement.Id);
                    placementValidation = HostedPlacementUtil.ValidateCreatedPlacements(
                        app,
                        new List<long> { replacementElementId.Value },
                        p.roomId,
                        p.roomNumber,
                        p.roomSide,
                        warnings
                    );
                    if (!placementValidation.valid)
                        throw new InvalidOperationException($"Replacement placement validation failed. {placementValidation.reason}");

                    doc.Delete(element.Id);
                    doc.Regenerate();
                    activeElement = replacement;
                    activeFamilyInstance = replacement;
                    usedFaceHostedReplacement = true;
                    return;
                }

                var refreshedPoint = HostedPlacementUtil.TryGetElementPoint(element) ?? currentPoint;
                var delta = targetPoint - refreshedPoint;
                if (delta.GetLength() > 1e-6)
                    ElementTransformUtils.MoveElement(doc, element.Id, delta);

                if ((p.matchOrientationFromSource ?? false) && orientationSource != null && orientationSource.Id != element.Id)
                {
                    HostedPlacementUtil.ApplyRotationAndFlip(
                        orientationSource,
                        familyInstance,
                        p.copyRotation,
                        p.copyFacingHandState,
                        warnings
                    );
                }
                else if (p.rotateToHostRelativeDegrees.HasValue && targetFrame != null && p.copyRotation)
                {
                    var currentRelative = HostedPlacementUtil.TryComputeOrientationRelativeToHostRadians(element, targetFrame);
                    if (currentRelative.HasValue)
                    {
                        var targetRadians = HostedPlacementUtil.NormalizeRadians((p.rotateToHostRelativeDegrees.Value * Math.PI) / 180.0);
                        var deltaRadians = HostedPlacementUtil.NormalizeRadians(targetRadians - currentRelative.Value);
                        if (Math.Abs(deltaRadians) > 1e-5)
                        {
                            var pivot = HostedPlacementUtil.TryGetElementPoint(element) ?? targetPoint;
                            var axis = Line.CreateBound(pivot, pivot + XYZ.BasisZ);
                            ElementTransformUtils.RotateElement(doc, element.Id, axis, deltaRadians);
                        }
                    }
                }

                if (p.matchElectricalCircuitFromSource)
                {
                    var circuitMatched = HostedPlacementUtil.TryReassignElectricalCircuitFromSource(
                        electricalCircuitSource,
                        familyInstance,
                        p.requireElectricalCircuitMatch,
                        warnings,
                        out var circuitDetail
                    );
                    circuitActionDetail = circuitDetail;
                    if (!circuitMatched && p.requireElectricalCircuitMatch)
                    {
                        throw new InvalidOperationException(circuitDetail);
                    }
                    if (!string.IsNullOrWhiteSpace(circuitDetail))
                    {
                        warnings.Add(circuitDetail);
                    }
                }
            }

            void CapturePreview(string defaultLabel, Element? previewOrientationElement)
            {
                if (!p.includePreviewImage) return;
                using var tg = new TransactionGroup(doc, "Adjust Hosted Instance On Host Preview");
                tg.Start();
                var adjustedPoint = HostedPlacementUtil.TryGetElementPoint(activeElement) ?? targetPoint;
                var adjustedFrame = HostedPlacementUtil.BuildHostLocalFrameData(host, roomWall, adjustedPoint);
                var labels = new List<PlacementPreviewLabel>
                {
                    new PlacementPreviewLabel
                    {
                        text = string.IsNullOrWhiteSpace(p.label) ? defaultLabel : p.label!,
                        secondaryText = HostedPlacementUtil.BuildPlacementPreviewSecondaryText(adjustedFrame, previewOrientationElement),
                        point = adjustedPoint,
                        direction = adjustedFrame?.tangent,
                        directionLengthFt = 2.0
                    }
                };
                (previewPath, previewWidth, previewHeight) = HostedPlacementUtil.ExportPlacementPreview(
                    doc,
                    previewView,
                    new List<long> { ElementIdCompat.GetValue(activeElement.Id) },
                    labels,
                    Math.Max(600, Math.Min(4000, p.previewImageSize ?? 2200)),
                    Math.Max(0.0, Math.Min(100.0, p.focusPaddingFt ?? 6.0)),
                    warnings
                );
                tg.RollBack();
            }

            if (p.dryRun)
            {
                using var tg = new TransactionGroup(doc, "Adjust Hosted Instance On Host (Dry Run)");
                tg.Start();
                using (var tx = new Transaction(doc, "Adjust Hosted Instance On Host"))
                {
                    tx.Start();
                    ApplyAdjustment();
                    tx.Commit();
                }
                CapturePreview("planned adjustment", (p.matchOrientationFromSource ?? false) ? orientationSource : element);
                var plannedElementId = usedFaceHostedReplacement ? replacementElementId : p.elementId;
                var plannedStrategy = usedFaceHostedReplacement ? "recreate_linked_face_then_delete_original" : "translate_existing_instance";
                var plannedCircuitAfter = HostedPlacementUtil.BuildElectricalCircuitAuditPayload(activeFamilyInstance);
                tg.RollBack();
                return Task.FromResult<object>(new
                {
                    status = "Planned",
                    dryRun = true,
                    originalElementId,
                    elementId = p.elementId,
                    temporaryReplacementElementId = usedFaceHostedReplacement ? plannedElementId : null,
                    replacementStrategy = plannedStrategy,
                    originalRetained = true,
                    host = HostedPlacementUtil.BuildPlacementHostPayload(host),
                    moveVector = new { x = targetPoint.X - currentPoint.X, y = targetPoint.Y - currentPoint.Y, z = targetPoint.Z - currentPoint.Z },
                    placementPoint = new { x = targetPoint.X, y = targetPoint.Y, z = targetPoint.Z },
                    hostLocalFrameBefore = HostedPlacementUtil.BuildHostLocalFramePayload(currentFrame, element),
                    hostLocalFrameAfter = HostedPlacementUtil.BuildHostLocalFramePayload(targetFrame, (p.matchOrientationFromSource ?? false) ? orientationSource : element),
                    electricalCircuitBefore = circuitAuditBefore,
                    electricalCircuitAfter = plannedCircuitAfter,
                    placementValidation,
                    circuitActionDetail = string.IsNullOrWhiteSpace(circuitActionDetail) ? null : circuitActionDetail,
                    preview = previewPath != null ? new { path = previewPath, widthPx = previewWidth, heightPx = previewHeight } : null,
                    warnings
                });
            }

            using (var tx = new Transaction(doc, "Adjust Hosted Instance On Host"))
            {
                tx.Start();
                ApplyAdjustment();
                tx.Commit();
            }

            CapturePreview("adjusted instance", (p.matchOrientationFromSource ?? false) ? orientationSource : element);
            if (usedFaceHostedReplacement)
            {
                if (replacementElementId == null || doc.GetElement(ElementIdCompat.Create(replacementElementId.Value)) == null)
                    throw new InvalidOperationException("Hosted replacement did not persist after commit.");
                if (doc.GetElement(ElementIdCompat.Create(originalElementId)) != null)
                    throw new InvalidOperationException("Original hosted instance still exists after replacement commit.");
            }

            var finalPoint = HostedPlacementUtil.TryGetElementPoint(activeElement) ?? targetPoint;
            var finalFrame = HostedPlacementUtil.BuildHostLocalFrameData(host, roomWall, finalPoint);
            var circuitAuditAfter = HostedPlacementUtil.BuildElectricalCircuitAuditPayload(activeFamilyInstance);
            return Task.FromResult<object>(new
            {
                status = "Adjusted",
                dryRun = false,
                originalElementId,
                elementId = ElementIdCompat.GetValue(activeElement.Id),
                replacementStrategy = usedFaceHostedReplacement ? "recreate_linked_face_then_delete_original" : "translate_existing_instance",
                originalDeleted = usedFaceHostedReplacement,
                host = HostedPlacementUtil.BuildPlacementHostPayload(host),
                moveVector = new { x = finalPoint.X - currentPoint.X, y = finalPoint.Y - currentPoint.Y, z = finalPoint.Z - currentPoint.Z },
                placementPoint = new { x = finalPoint.X, y = finalPoint.Y, z = finalPoint.Z },
                hostLocalFrameBefore = HostedPlacementUtil.BuildHostLocalFramePayload(currentFrame, element),
                hostLocalFrameAfter = HostedPlacementUtil.BuildHostLocalFramePayload(finalFrame, (p.matchOrientationFromSource ?? false) ? orientationSource : element),
                electricalCircuitBefore = circuitAuditBefore,
                electricalCircuitAfter = circuitAuditAfter,
                placementValidation,
                circuitActionDetail = string.IsNullOrWhiteSpace(circuitActionDetail) ? null : circuitActionDetail,
                preview = previewPath != null ? new { path = previewPath, widthPx = previewWidth, heightPx = previewHeight } : null,
                warnings
            });
        }
    }
}
