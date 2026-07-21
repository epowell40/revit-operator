using System;
using System.Collections.Generic;
using System.Linq;
using System.Text.Json;
using System.Threading.Tasks;
using Autodesk.Revit.DB;
using Autodesk.Revit.DB.Architecture;
using Autodesk.Revit.DB.Mechanical;
using Autodesk.Revit.UI;
using RevitBridge.Common;
using RevitBridge.Logic.Handlers.Core;
using RevitBridge.Logic.Handlers.MEP;

namespace RevitBridge.Logic.Handlers
{
    internal static class SpatialIntentUtils
    {
        internal static XYZ GetElementCenter(Element e)
        {
            var bb = e.get_BoundingBox(null);
            if (bb == null) return XYZ.Zero;
            return (bb.Min + bb.Max) * 0.5;
        }

        internal static long? GetId(ElementId id)
        {
            if (id == null || id == ElementId.InvalidElementId) return null;
            return ElementIdCompat.GetValue(id);
        }

        internal static string GetLevelName(Document doc, Element e)
        {
            try
            {
                if (e.LevelId != null && e.LevelId != ElementId.InvalidElementId)
                {
                    var level = doc.GetElement(e.LevelId) as Level;
                    if (level != null) return level.Name;
                }
            }
            catch { }

            var p = e.get_Parameter(BuiltInParameter.FAMILY_LEVEL_PARAM) ?? e.get_Parameter(BuiltInParameter.INSTANCE_REFERENCE_LEVEL_PARAM);
            if (p != null && p.StorageType == StorageType.ElementId)
            {
                var level = doc.GetElement(p.AsElementId()) as Level;
                if (level != null) return level.Name;
            }

            foreach (var paramName in new[] { "Schedule Level", "Level", "Reference Level" })
            {
                try
                {
                    var named = e.LookupParameter(paramName);
                    if (named == null || named.StorageType != StorageType.ElementId) continue;
                    var level = doc.GetElement(named.AsElementId()) as Level;
                    if (level != null) return level.Name;
                }
                catch { }
            }

            return string.Empty;
        }

        internal static SpatialElement? GetSpatialElement(Document doc, Element e)
        {
            if (e is SpatialElement spatial) return spatial;
            var fi = e as FamilyInstance;
            if (fi == null) return null;

            try
            {
                if (fi.Space != null) return fi.Space;
            }
            catch { }

            return fi.Room ?? fi.FromRoom ?? fi.ToRoom;
        }

        internal static Room? GetRoom(Document doc, Element e)
        {
            return GetSpatialElement(doc, e) as Room;
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

        internal static string? GetSpatialKind(SpatialElement? spatial)
        {
            return spatial switch
            {
                Room => "Room",
                Space => "Space",
                null => null,
                _ => "SpatialElement"
            };
        }

        internal static double DistanceFt(Element a, Element b)
        {
            return GetElementCenter(a).DistanceTo(GetElementCenter(b));
        }
    }

    public class LocateElementsHandler : IRequestHandler
    {
        public class Params
        {
            public List<long> elementIds { get; set; }
            public List<string> categories { get; set; }
            public List<string> levelNames { get; set; }
            public string roomNumber { get; set; }
            public string roomNameContains { get; set; }
            public long? nearElementId { get; set; }
            public double? maxDistanceFt { get; set; }
            public int? limit { get; set; } = 200;
        }

        public Task<object> Handle(UIApplication app, string jsonData)
        {
            var p = string.IsNullOrWhiteSpace(jsonData) ? new Params() : JsonSerializer.Deserialize<Params>(jsonData);
            var doc = app.ActiveUIDocument?.Document ?? throw new InvalidOperationException("No active UI document.");

            var warnings = new List<string>();
            var categorySet = new HashSet<string>((p?.categories ?? new List<string>()).Where(s => !string.IsNullOrWhiteSpace(s)), StringComparer.OrdinalIgnoreCase);
            var levelSet = new HashSet<string>((p?.levelNames ?? new List<string>()).Where(s => !string.IsNullOrWhiteSpace(s)), StringComparer.OrdinalIgnoreCase);
            var limit = Math.Max(1, Math.Min(2000, p?.limit ?? 200));

            var candidateIds = p?.elementIds?.Where(x => x > 0).Distinct().ToList() ?? new List<long>();
            var candidates = new List<Element>();
            if (candidateIds.Count > 0)
            {
                foreach (var id in candidateIds)
                {
                    var e = doc.GetElement(ElementIdCompat.Create(id));
                    if (e != null) candidates.Add(e);
                }
            }
            else
            {
                var collector = new FilteredElementCollector(doc).WhereElementIsNotElementType();
                var nativePredicates = new List<string>();

                if (categorySet.Count > 0)
                {
                    var builtInCategories = new List<BuiltInCategory>();
                    var unknownCategories = new List<string>();
                    BuiltInCategoryTokenUtil.ParseMany(categorySet, builtInCategories, unknownCategories);
                    builtInCategories = builtInCategories.Distinct().ToList();
                    if (builtInCategories.Count == 1)
                    {
                        collector.OfCategory(builtInCategories[0]);
                        nativePredicates.Add("category");
                    }
                    else if (builtInCategories.Count > 1)
                    {
                        collector.WherePasses(new ElementMulticategoryFilter(builtInCategories));
                        nativePredicates.Add("categories");
                    }
                    if (unknownCategories.Count > 0)
                    {
                        warnings.Add($"Unknown categories rejected from native collection: {string.Join(", ", unknownCategories)}.");
                        if (builtInCategories.Count == 0)
                        {
                            return Task.FromResult<object>(new { status = "Ok", count = 0, truncated = false, items = new List<object>(), warnings });
                        }
                    }
                }

                if (levelSet.Count > 0)
                {
                    var levelIds = new FilteredElementCollector(doc)
                        .OfClass(typeof(Level))
                        .Cast<Level>()
                        .Where(level => levelSet.Contains(level.Name))
                        .Select(level => level.Id)
                        .ToList();
                    if (levelIds.Count == 0)
                    {
                        warnings.Add($"No exact levels resolved: {string.Join(", ", levelSet)}.");
                        return Task.FromResult<object>(new { status = "Ok", count = 0, truncated = false, items = new List<object>(), warnings });
                    }
                    if (levelIds.Count == 1) collector.WherePasses(new ElementLevelFilter(levelIds[0]));
                    else collector.WherePasses(new LogicalOrFilter(levelIds.Select(id => (ElementFilter)new ElementLevelFilter(id)).ToList()));
                    nativePredicates.Add("level");
                }

                candidates = collector.ToElements().ToList();
                warnings.Add(nativePredicates.Count > 0
                    ? $"Native collector predicates applied: {string.Join(", ", nativePredicates)}."
                    : "No elementIds or native category/level predicates provided; scanned full model scope.");
            }

            Element nearElement = null;
            if (p?.nearElementId.HasValue == true)
            {
                nearElement = doc.GetElement(ElementIdCompat.Create(p.nearElementId.Value));
                if (nearElement == null) warnings.Add($"nearElementId {p.nearElementId.Value} not found; proximity filter skipped.");
            }

            var items = new List<object>();
            foreach (var e in candidates)
            {
                if (categorySet.Count > 0)
                {
                    var bic = e.Category?.BuiltInCategory.ToString() ?? string.Empty;
                    var catName = e.Category?.Name ?? string.Empty;
                    if (!categorySet.Contains(bic) && !categorySet.Contains(catName)) continue;
                }

                var levelName = SpatialIntentUtils.GetLevelName(doc, e);
                if (levelSet.Count > 0 && !levelSet.Contains(levelName)) continue;

                var spatial = SpatialIntentUtils.GetSpatialElement(doc, e);
                var spatialNumber = SpatialIntentUtils.GetSpatialNumber(spatial);
                var spatialName = SpatialIntentUtils.GetSpatialName(spatial);
                if (!string.IsNullOrWhiteSpace(p?.roomNumber) && !string.Equals(spatialNumber ?? string.Empty, p.roomNumber, StringComparison.OrdinalIgnoreCase)) continue;
                if (!string.IsNullOrWhiteSpace(p?.roomNameContains) && (spatialName ?? string.Empty).IndexOf(p.roomNameContains, StringComparison.OrdinalIgnoreCase) < 0) continue;

                double? nearDistance = null;
                if (nearElement != null)
                {
                    nearDistance = SpatialIntentUtils.DistanceFt(e, nearElement);
                    if (p?.maxDistanceFt.HasValue == true && nearDistance.Value > p.maxDistanceFt.Value) continue;
                }

                var hostId = SpatialIntentUtils.GetId((e as FamilyInstance)?.Host?.Id);
                var center = SpatialIntentUtils.GetElementCenter(e);
                items.Add(new
                {
                    elementId = ElementIdCompat.GetValue(e.Id),
                    category = e.Category?.Name,
                    builtInCategory = e.Category?.BuiltInCategory.ToString(),
                    name = e.Name,
                    levelName,
                    roomNumber = spatialNumber,
                    roomName = spatialName,
                    spatialKind = SpatialIntentUtils.GetSpatialKind(spatial),
                    spatialId = SpatialIntentUtils.GetId(spatial?.Id),
                    hostId,
                    nearDistanceFt = nearDistance,
                    center = new { x = center.X, y = center.Y, z = center.Z }
                });

                if (items.Count >= limit) break;
            }

            return Task.FromResult<object>(new
            {
                status = "Ok",
                count = items.Count,
                truncated = items.Count >= limit,
                items,
                warnings
            });
        }
    }

    public class GetPlacementContextHandler : IRequestHandler
    {
        public class Params
        {
            public long elementId { get; set; }
            public List<string> hostCategories { get; set; }
            public double? hostSearchRadiusFt { get; set; } = 12;
            public int? maxNearbyHosts { get; set; } = 5;
            public double[]? pointXyz { get; set; }
            public string? roomNumber { get; set; }
            public string? roomSide { get; set; }
        }

        public Task<object> Handle(UIApplication app, string jsonData)
        {
            var p = JsonSerializer.Deserialize<Params>(jsonData ?? "{}") ?? new Params();
            var doc = app.ActiveUIDocument?.Document ?? throw new InvalidOperationException("No active UI document.");
            if (p.elementId <= 0) throw new InvalidOperationException("elementId is required.");

            var e = doc.GetElement(ElementIdCompat.Create(p.elementId));
            if (e == null) throw new InvalidOperationException($"Element {p.elementId} not found.");

            var center = HostedPlacementUtil.TryGetElementPoint(e) ?? SpatialIntentUtils.GetElementCenter(e);
            var levelName = SpatialIntentUtils.GetLevelName(doc, e);
            var room = SpatialIntentUtils.GetSpatialElement(doc, e);
            var familyInstance = e as FamilyInstance;
            var host = familyInstance?.Host;
            // Linked-face hosted instances can legitimately report Host == null
            // while HostFace still points at the RevitLinkInstance. Preserve that
            // factual host instead of misclassifying a valid device as unhosted.
            if (host == null && familyInstance?.HostFace != null)
            {
                try { host = doc.GetElement(familyInstance.HostFace.ElementId); } catch { host = null; }
            }
            object? sourceHostFace = null;
            if (familyInstance?.HostFace != null)
            {
                try
                {
                    var hostFace = familyInstance.HostFace;
                    var elementId = ElementIdCompat.GetValue(hostFace.ElementId);
                    var linkedElementId = ElementIdCompat.GetValue(hostFace.LinkedElementId);
                    sourceHostFace = new
                    {
                        stableReference = hostFace.ConvertToStableRepresentation(doc),
                        elementId,
                        linkedElementId = linkedElementId > 0 ? linkedElementId : (long?)null,
                        isLinked = linkedElementId > 0
                    };
                }
                catch
                {
                    // Host-face references are read-only evidence. If Revit cannot
                    // serialize one, preserve the rest of the placement context and
                    // leave the exact-face fields unavailable instead of guessing.
                    sourceHostFace = null;
                }
            }
            var bestView = ResolveBestView(doc, app.ActiveUIDocument?.ActiveView, e, levelName);
            var searchPoint =
                p.pointXyz != null && p.pointXyz.Length >= 3
                    ? new XYZ(p.pointXyz[0], p.pointXyz[1], p.pointXyz[2])
                    : center;

            var maxHosts = Math.Max(1, Math.Min(20, p.maxNearbyHosts ?? 5));
            var radiusFt = Math.Max(0.5, Math.Min(1000, p.hostSearchRadiusFt ?? 12));
            var hostCatSet = new HashSet<string>((p.hostCategories ?? new List<string>()).Where(x => !string.IsNullOrWhiteSpace(x)), StringComparer.OrdinalIgnoreCase);
            var view = app.ActiveUIDocument?.ActiveView;
            var requestedRoom = HostedPlacementUtil.FindSpatialElement(doc, null, p.roomNumber)?.element ?? room;
            var nearbyHostRows = HostedPlacementUtil.FindNearbyHosts(
                doc,
                view ?? doc.ActiveView,
                searchPoint,
                hostCatSet.Count > 0 ? hostCatSet : new HashSet<string>(new[] { "OST_Walls" }, StringComparer.OrdinalIgnoreCase),
                radiusFt,
                requestedRoom,
                p.roomSide,
                maxHosts
            );

            HostedPlacementUtil.TryGetTypeInfo(doc, e, out var typeId, out var typeName, out var familyName);
            var insertionPoint = HostedPlacementUtil.TryGetElementPoint(e);
            var electricalCircuit = e is FamilyInstance circuitFamilyInstance
                ? HostedPlacementUtil.BuildElectricalCircuitAuditPayload(circuitFamilyInstance)
                : null;
            // A null requested name makes this a read-only audit. This exposes the
            // document's exact electrical settings and the equipment type's compatible
            // systems without mutating the source model or guessing voltage settings.
            var electricalDistributionSystem = e is FamilyInstance electricalFamilyInstance
                ? HostedPlacementUtil.ApplyAndAuditElectricalDistributionSystem(doc, electricalFamilyInstance, null)
                : null;
            var roomWallContext = requestedRoom != null && !string.IsNullOrWhiteSpace(p.roomSide)
                ? HostedPlacementUtil.ResolveRoomWalls(doc, requestedRoom, view ?? doc.ActiveView, p.roomSide, 4)
                : new List<RoomWallResolution>();
            var hostId = host != null ? ElementIdCompat.GetValue(host.Id) : 0L;
            var matchedRoomWall = roomWallContext.FirstOrDefault(x => x.hostElementId == hostId) ?? roomWallContext.FirstOrDefault();
            var sourceHostSupported = HostedPlacementUtil.IsSupportedPlacementHost(host);
            var placementHost = sourceHostSupported
                ? host
                : nearbyHostRows.Select(x => x.element).FirstOrDefault(HostedPlacementUtil.IsSupportedPlacementHost);
            var wallHost = placementHost as Wall;
            object? wallPlacement = null;
            if (wallHost != null && insertionPoint != null && HostedPlacementUtil.TryProjectPointToWall(wallHost, insertionPoint, out var projected, out var tangent, out var curveLengthFt, out var offsetFt))
            {
                wallPlacement = new
                {
                    hostElementId = ElementIdCompat.GetValue(wallHost.Id),
                    projectedPoint = HostedPlacementUtil.BuildVector(projected),
                    tangent = HostedPlacementUtil.BuildVector(tangent),
                    curveLengthFt,
                    offsetFromCurveFt = offsetFt,
                    basis = "wall_host"
                };
            }
            else if (placementHost is RevitLinkInstance linkHost && matchedRoomWall != null)
            {
                var projectionSeed = insertionPoint ?? searchPoint;
                if (HostedPlacementUtil.TryProjectPointToRoomWall(matchedRoomWall, projectionSeed, out var projectedBoundary, out var boundaryTangent, out var boundaryCurveLengthFt, out var boundaryOffsetFt))
                {
                    wallPlacement = new
                    {
                        hostElementId = ElementIdCompat.GetValue(linkHost.Id),
                        projectedPoint = HostedPlacementUtil.BuildVector(projectedBoundary),
                        tangent = HostedPlacementUtil.BuildVector(boundaryTangent),
                        curveLengthFt = boundaryCurveLengthFt,
                        offsetFromCurveFt = boundaryOffsetFt,
                        basis = "linked_room_boundary"
                    };
                }
            }

            string placementSupportReason;
            if (placementHost != null && sourceHostSupported)
                placementSupportReason = host is Wall ? "source_host_supported" : "source_link_host_supported";
            else if (placementHost is RevitLinkInstance)
                placementSupportReason = "using_requested_room_side_link_host";
            else if (placementHost is Wall)
                placementSupportReason = "using_nearby_wall_host";
            else if (host != null)
                placementSupportReason = $"unsupported_source_host:{host.Category?.Name ?? host.GetType().Name}";
            else
                placementSupportReason = "no_supported_host_found";

            var placementHostSupported = HostedPlacementUtil.IsSupportedPlacementHost(placementHost);
            var placementHostId = placementHost != null ? ElementIdCompat.GetValue(placementHost.Id) : 0L;
            var matchedPlacementRoomWall = roomWallContext.FirstOrDefault(x => x.hostElementId == placementHostId) ?? matchedRoomWall;
            var placementHostContext =
                matchedPlacementRoomWall != null && placementHost != null && placementHostId == matchedPlacementRoomWall.hostElementId
                    ? HostedPlacementUtil.BuildRoomWallHostContextPayload(matchedPlacementRoomWall)
                    : null;
            var placementFrame = placementHost != null
                ? HostedPlacementUtil.BuildHostLocalFrameData(placementHost, matchedPlacementRoomWall, insertionPoint ?? searchPoint)
                : null;
            var requestedRoomNumber = HostedPlacementUtil.GetSpatialNumber(requestedRoom);
            var actualRoomNumber = SpatialIntentUtils.GetSpatialNumber(room);
            var requestedWallHostIds = roomWallContext.Select(x => x.hostElementId).Where(id => id > 0).Distinct().ToList();
            var inRequestedRoom = string.IsNullOrWhiteSpace(requestedRoomNumber) || string.Equals(actualRoomNumber ?? "", requestedRoomNumber ?? "", StringComparison.OrdinalIgnoreCase);
            var onRequestedWall = requestedWallHostIds.Count == 0 || (placementHostId > 0 && requestedWallHostIds.Contains(placementHostId));
            var suggestedChainageFt = placementFrame?.chainageFt;
            var suggestedNormalizedChainage = placementFrame?.normalizedChainage;

            return Task.FromResult<object>(new
            {
                status = "Ok",
                elementId = p.elementId,
                uniqueId = e.UniqueId,
                category = e.Category?.Name,
                builtInCategory = e.Category?.BuiltInCategory.ToString(),
                name = e.Name,
                center = new { x = center.X, y = center.Y, z = center.Z },
                insertionPoint = insertionPoint == null ? null : new { x = insertionPoint.X, y = insertionPoint.Y, z = insertionPoint.Z },
                levelName,
                typeId,
                typeName,
                familyName,
                systemName = MepSystemUtil.TryGetSystemName(e),
                bestView,
                room = room == null ? null : new
                {
                    number = SpatialIntentUtils.GetSpatialNumber(room),
                    name = SpatialIntentUtils.GetSpatialName(room),
                    id = ElementIdCompat.GetValue(room.Id),
                    kind = SpatialIntentUtils.GetSpatialKind(room)
                },
                host = HostedPlacementUtil.BuildPlacementHostPayload(host),
                sourceHostFace,
                placementHost = HostedPlacementUtil.BuildPlacementHostPayload(placementHost),
                placementHostContext,
                electricalCircuit,
                electricalDistributionSystem,
                orientation = HostedPlacementUtil.BuildOrientationPayload(e),
                wallPlacement,
                hostLocalFrame = HostedPlacementUtil.BuildHostLocalFramePayload(placementFrame, e),
                diagnostics = new
                {
                    isHosted = host != null,
                    elevationFt = center.Z,
                    requestedPoint = new { x = searchPoint.X, y = searchPoint.Y, z = searchPoint.Z },
                    requestedRoomSide = HostedPlacementUtil.NormalizeWallSide(p.roomSide),
                    placementAudit = new
                    {
                        requestedRoomNumber,
                        actualRoomNumber,
                        requestedWallHostIds,
                        inRequestedRoom,
                        onRequestedWall
                    },
                    hostPlacementSupport = new
                    {
                        supported = placementHostSupported,
                        sourceHostSupported,
                        reason = placementSupportReason
                    }
                },
                nearbyHosts = nearbyHostRows.Select((candidate, index) => new
                {
                    rank = index + 1,
                    elementId = ElementIdCompat.GetValue(candidate.element.Id),
                    category = candidate.element.Category?.Name,
                    builtInCategory = candidate.element.Category?.BuiltInCategory.ToString(),
                    name = candidate.element.Name,
                    distanceFt = candidate.distanceFt,
                    onRequestedRoomSide = candidate.onRequestedRoomSide,
                    point = HostedPlacementUtil.BuildVector(candidate.point),
                    projectedPointOnHost = HostedPlacementUtil.BuildVector(candidate.projectedPointOnHost),
                    hostTangent = HostedPlacementUtil.BuildVector(candidate.hostTangent),
                    hostOffsetFt = candidate.hostOffsetFt,
                    supportsPlacement = candidate.supportsPlacement
                }).ToList(),
                requestedRoomWalls = roomWallContext.Select(w => new
                {
                    hostElementId = w.hostElementId,
                    hostCategory = w.hostElement?.Category?.Name,
                    hostBuiltInCategory = w.hostElement?.Category?.BuiltInCategory.ToString(),
                    hostName = w.hostElement?.Name,
                    hostContext = HostedPlacementUtil.BuildRoomWallHostContextPayload(w),
                    boundaryLengthFt = w.boundaryLengthFt,
                    midpoint = HostedPlacementUtil.BuildVector(w.midpoint),
                    tangent = HostedPlacementUtil.BuildVector(w.tangent),
                    projectedRoomPoint = HostedPlacementUtil.BuildVector(w.projectedRoomPoint),
                    interiorDirection = HostedPlacementUtil.BuildVector(w.interiorDirection),
                    supportsPlacement = w.supportsPlacement
                }).ToList(),
                suggestedPlacement = !placementHostSupported ? null : new
                {
                    placeOnHost = new
                    {
                        action = "/revit/place-family-instance-on-host",
                        body = new
                        {
                            sourceElementId = p.elementId,
                            hostElementId = ElementIdCompat.GetValue(placementHost.Id),
                            roomNumber = requestedRoomNumber,
                            roomSide = HostedPlacementUtil.NormalizeWallSide(p.roomSide),
                            referenceElementId = p.elementId,
                            matchOrientationFromSource = true,
                            orientationSourceElementId = p.elementId,
                            targetChainageFt = suggestedChainageFt,
                            targetNormalizedChainage = suggestedNormalizedChainage,
                            elevationFt = insertionPoint?.Z ?? center.Z,
                            dryRun = true,
                            includePreviewImage = true
                        }
                    },
                    createSimilar = new
                    {
                        action = "/revit/create-similar-from-instance",
                        body = new
                        {
                            exemplarElementId = p.elementId,
                            hostElementId = ElementIdCompat.GetValue(placementHost.Id),
                            roomNumber = requestedRoomNumber,
                            roomSide = HostedPlacementUtil.NormalizeWallSide(p.roomSide),
                            referenceElementId = p.elementId,
                            matchOrientationFromSource = true,
                            orientationSourceElementId = p.elementId,
                            dryRun = true,
                            includePreviewImage = true
                        }
                    }
                }
            });
        }

        private static object ResolveBestView(Document doc, View activeView, Element element, string levelName)
        {
            bool VisibleIn(View view)
            {
                if (view == null || view.IsTemplate) return false;
                try { return element.get_BoundingBox(view) != null; }
                catch { return false; }
            }

            if (activeView is ViewPlan && VisibleIn(activeView))
            {
                return new
                {
                    id = ElementIdCompat.GetValue(activeView.Id),
                    name = activeView.Name,
                    viewType = activeView.ViewType.ToString(),
                    reason = "active_view_visible"
                };
            }

            var levelPlan = new FilteredElementCollector(doc)
                .OfClass(typeof(ViewPlan))
                .Cast<ViewPlan>()
                .Where(view => !view.IsTemplate && string.Equals(view.GenLevel?.Name ?? "", levelName ?? "", StringComparison.OrdinalIgnoreCase))
                .OrderBy(view => view.ViewType == ViewType.EngineeringPlan ? 0 : view.ViewType == ViewType.FloorPlan ? 1 : 2)
                .ThenBy(view => view.Name, StringComparer.OrdinalIgnoreCase)
                .FirstOrDefault(VisibleIn);
            if (levelPlan != null) return new
            {
                id = ElementIdCompat.GetValue(levelPlan.Id),
                name = levelPlan.Name,
                viewType = levelPlan.ViewType.ToString(),
                reason = "same_level_visible_plan"
            };

            if (activeView != null && !(activeView is ViewSheet) && !(activeView is ViewSchedule) && VisibleIn(activeView))
            {
                return new
                {
                    id = ElementIdCompat.GetValue(activeView.Id),
                    name = activeView.Name,
                    viewType = activeView.ViewType.ToString(),
                    reason = "active_graphical_view_visible"
                };
            }
            return null;
        }
    }

    public class ResolveRedlineTargetHandler : IRequestHandler
    {
        public class SheetRegion
        {
            public double minU { get; set; }
            public double minV { get; set; }
            public double maxU { get; set; }
            public double maxV { get; set; }
        }

        public class Params
        {
            public string sheetNumber { get; set; }
            public List<SheetRegion> sheetRegions { get; set; }
            public List<string> categories { get; set; }
            public string textContains { get; set; }
            public int? limit { get; set; } = 25;
        }

        public async Task<object> Handle(UIApplication app, string jsonData)
        {
            var p = JsonSerializer.Deserialize<Params>(jsonData ?? "{}") ?? new Params();
            if (string.IsNullOrWhiteSpace(p.sheetNumber)) throw new InvalidOperationException("sheetNumber is required.");

            var payload = new
            {
                sheetNumber = p.sheetNumber,
                includeSheetElements = true,
                includeViewportElements = true,
                sheetRegions = p.sheetRegions,
                categories = p.categories,
                textContains = p.textContains,
                limit = p.limit ?? 25
            };

            var findRes = await new FindElementsHandler().Handle(app, JsonSerializer.Serialize(payload));
            var doc = JsonDocument.Parse(JsonSerializer.Serialize(findRes));

            var ids = new List<long>();
            if (doc.RootElement.TryGetProperty("elementIds", out var elementIds) && elementIds.ValueKind == JsonValueKind.Array)
            {
                foreach (var id in elementIds.EnumerateArray())
                {
                    if (id.TryGetInt64(out var value)) ids.Add(value);
                }
            }

            var confidence = ids.Count == 0 ? 0.0 : (ids.Count == 1 ? 0.95 : Math.Max(0.4, 0.95 - (ids.Count - 1) * 0.1));

            return new
            {
                status = "Ok",
                candidates = ids,
                confidence,
                coordinateLineage = new
                {
                    sheetNumber = p.sheetNumber,
                    sheetRegions = p.sheetRegions ?? new List<SheetRegion>(),
                    strategy = "sheet-region-find-elements"
                },
                rationale = ids.Count == 0 ? "No sheet-scoped candidates matched the provided filters." : "Candidates ranked by deterministic sheet-region filtering.",
                findElementsResult = findRes
            };
        }
    }

    public class ProposeFixHandler : IRequestHandler
    {
        public class Params
        {
            public long elementId { get; set; }
            public string expectedHostCategory { get; set; }
            public double? expectedElevationFt { get; set; }
            public double? toleranceFt { get; set; } = 0.25;
        }

        public Task<object> Handle(UIApplication app, string jsonData)
        {
            var p = JsonSerializer.Deserialize<Params>(jsonData ?? "{}") ?? new Params();
            var doc = app.ActiveUIDocument?.Document ?? throw new InvalidOperationException("No active UI document.");
            if (p.elementId <= 0) throw new InvalidOperationException("elementId is required.");

            var e = doc.GetElement(ElementIdCompat.Create(p.elementId));
            if (e == null) throw new InvalidOperationException($"Element {p.elementId} not found.");

            var center = SpatialIntentUtils.GetElementCenter(e);
            var host = (e as FamilyInstance)?.Host;
            var tolerance = Math.Max(0.01, p.toleranceFt ?? 0.25);
            var suggestions = new List<object>();
            var diagnostics = new List<object>();

            if (!string.IsNullOrWhiteSpace(p.expectedHostCategory))
            {
                var hostCategory = host?.Category?.BuiltInCategory.ToString() ?? host?.Category?.Name ?? string.Empty;
                var hostOk = string.Equals(hostCategory, p.expectedHostCategory, StringComparison.OrdinalIgnoreCase);
                diagnostics.Add(new { check = "hosting", pass = hostOk, actual = hostCategory, expected = p.expectedHostCategory });
                if (!hostOk)
                {
                    suggestions.Add(new
                    {
                        action = "/revit/get-placement-context",
                        reason = "Resolve nearest legal hosts before re-hosting.",
                        proposedBody = new { elementId = p.elementId, hostCategories = new[] { p.expectedHostCategory } }
                    });
                }
            }

            if (p.expectedElevationFt.HasValue)
            {
                var delta = center.Z - p.expectedElevationFt.Value;
                var pass = Math.Abs(delta) <= tolerance;
                diagnostics.Add(new { check = "elevation", pass, actual = center.Z, expected = p.expectedElevationFt.Value, deltaFt = delta, toleranceFt = tolerance });
                if (!pass)
                {
                    suggestions.Add(new
                    {
                        action = "/revit/move-elements",
                        reason = "Adjust element elevation to expected target.",
                        proposedBody = new
                        {
                            elementIds = new[] { p.elementId },
                            translation = new { dz = -delta }
                        }
                    });
                }
            }

            return Task.FromResult<object>(new
            {
                status = "Ok",
                elementId = p.elementId,
                diagnostics,
                proposedActions = suggestions,
                safeToAutoApply = false
            });
        }
    }
}
