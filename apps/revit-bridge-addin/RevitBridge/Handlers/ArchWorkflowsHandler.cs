using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Reflection;
using System.Text.Json;
using System.Threading.Tasks;
using Autodesk.Revit.DB;
using Autodesk.Revit.DB.Architecture;
using Autodesk.Revit.DB.Structure;
using Autodesk.Revit.UI;
using RevitBridge.Common;

namespace RevitBridge.Handlers
{
    public sealed class ArchWorkflowsHandler : IRequestHandler
    {
        public sealed class Point3
        {
            public double x { get; set; }
            public double y { get; set; }
            public double? z { get; set; }
        }

        public sealed class PlacementSpec
        {
            public long? hostElementId { get; set; }
            public double x { get; set; }
            public double y { get; set; }
            public double z { get; set; }
            public double? rotationDegrees { get; set; }
            public long? alignToElementId { get; set; }
            public string? alignSourceSide { get; set; }
            public string? alignTargetSide { get; set; }
            public string? alignAxis { get; set; }
        }

        public sealed class Params
        {
            public string? action { get; set; }
            public bool? dryRun { get; set; }
            public int? max { get; set; }

            public long? viewId { get; set; }
            public List<long>? elementIds { get; set; }
            public long? firstElementId { get; set; }
            public long? secondElementId { get; set; }
            public string? mode { get; set; }

            public long? typeId { get; set; }
            public string? typeName { get; set; }
            public long? sourceTypeId { get; set; }
            public string? sourceTypeName { get; set; }
            public string? familyName { get; set; }
            public string? categoryName { get; set; }

            public string? levelName { get; set; }
            public long? levelId { get; set; }
            public bool? structural { get; set; }
            public double? heightFeet { get; set; }
            public string? wallTypeName { get; set; }
            public long? wallTypeId { get; set; }
            public string? floorTypeName { get; set; }
            public long? floorTypeId { get; set; }
            public string? ceilingTypeName { get; set; }
            public long? ceilingTypeId { get; set; }
            public long? roomId { get; set; }
            public string? roomNumber { get; set; }
            public List<Point3>? polyline { get; set; }

            public string? symbolName { get; set; }
            public List<PlacementSpec>? placements { get; set; }

            public int? count { get; set; }
            public double? spacingX { get; set; }
            public double? spacingY { get; set; }
            public double? spacingZ { get; set; }
            public bool? copy { get; set; }

            public Point3? planeOrigin { get; set; }
            public Point3? planeNormal { get; set; }

            public Point3? p1 { get; set; }
            public Point3? p2 { get; set; }
            public Point3? cutVec { get; set; }
            public string? name { get; set; }

            public double? x { get; set; }
            public double? y { get; set; }
            public double? z { get; set; }

            public bool? includeTypesWithDependencies { get; set; }
            public int? maxDelete { get; set; }
            public bool? createTags { get; set; }
            public bool? closeLoop { get; set; }
            public bool? lockConstraint { get; set; }
        }

        public Task<object> Handle(UIApplication app, string jsonData)
        {
            var p = string.IsNullOrWhiteSpace(jsonData)
                ? new Params()
                : (JsonSerializer.Deserialize<Params>(jsonData, new JsonSerializerOptions { PropertyNameCaseInsensitive = true }) ?? new Params());

            var uidoc = app.ActiveUIDocument ?? throw new InvalidOperationException("No active UI document.");
            var doc = uidoc.Document;
            var action = NormalizeAction(p.action);

            return action switch
            {
                "create_walls_from_polyline" => Task.FromResult(CreateWallsFromPolyline(doc, p)),
                "change_wall_type" => Task.FromResult(ChangeWallType(app, p)),
                "join_wall_geometry" => Task.FromResult(JoinWallGeometry(doc, p)),
                "place_hosted_instances" => Task.FromResult(PlaceHostedInstances(app, p)),
                "swap_family_type_in_view" => Task.FromResult(SwapFamilyTypeInView(doc, p)),
                "create_model_group_and_place" => Task.FromResult(CreateModelGroupAndPlace(doc, p)),
                "array_elements" => Task.FromResult(ArrayElements(doc, p)),
                "mirror_elements" => Task.FromResult(MirrorElements(doc, p)),
                "copy_same_place" => Task.FromResult(CopySamePlace(doc, p)),
                "create_reference_plane" => Task.FromResult(CreateReferencePlane(doc, uidoc.ActiveView, p)),
                "purge_duplicate_line_patterns" => Task.FromResult(PurgeDuplicateLinePatterns(doc, p)),
                "create_floor_from_walls" => Task.FromResult(CreateFloorFromWalls(doc, p)),
                "create_ceiling_in_room" => Task.FromResult(CreateCeilingInRoom(doc, p)),
                "create_rooms_and_tags" => Task.FromResult(CreateRoomsAndTags(doc, uidoc.ActiveView, p)),
                "create_room_separation_lines" => Task.FromResult(CreateRoomSeparationLines(doc, uidoc.ActiveView, p)),
                _ => throw new InvalidOperationException("arch-workflows.action must be one of: create_walls_from_polyline, change_wall_type, join_wall_geometry, place_hosted_instances, swap_family_type_in_view, create_model_group_and_place, array_elements, mirror_elements, copy_same_place, create_reference_plane, purge_duplicate_line_patterns, create_floor_from_walls, create_ceiling_in_room, create_rooms_and_tags, create_room_separation_lines.")
            };
        }

        private static object CreateWallsFromPolyline(Document doc, Params p)
        {
            var dryRun = p.dryRun ?? false;
            var points = (p.polyline ?? new List<Point3>()).Where(x => x != null).ToList();
            if (points.Count < 2) throw new InvalidOperationException("arch-workflows.create_walls_from_polyline requires at least two points.");

            var level = ResolveLevel(doc, p.levelId, p.levelName) ?? ResolveDefaultLevel(doc)
                ?? throw new InvalidOperationException("Unable to resolve a base level for wall creation.");
            var wallType = ResolveWallType(doc, p.wallTypeId, p.wallTypeName)
                ?? throw new InvalidOperationException("Unable to resolve wall type. Provide wallTypeId or wallTypeName.");
            var height = p.heightFeet.GetValueOrDefault(10.0);
            if (height <= 0) height = 10.0;
            var structural = p.structural ?? false;

            var created = new List<object>();
            using (var tx = new Transaction(doc, dryRun ? "Arch Workflows - Create Walls (Dry Run)" : "Arch Workflows - Create Walls"))
            {
                tx.Start();
                for (var i = 0; i < points.Count - 1; i++)
                {
                    var a = ToXyz(points[i]);
                    var b = ToXyz(points[i + 1]);
                    if (a.DistanceTo(b) < 1e-6) continue;

                    var wall = Wall.Create(doc, Line.CreateBound(a, b), wallType.Id, level.Id, height, 0.0, false, structural);
                    created.Add(new
                    {
                        index = i,
                        id = ElementIdCompat.GetValue(wall.Id),
                        start = new[] { a.X, a.Y, a.Z },
                        end = new[] { b.X, b.Y, b.Z }
                    });
                }

                if (dryRun) tx.RollBack();
                else tx.Commit();
            }

            return new
            {
                status = dryRun ? "Dry Run" : "Applied",
                action = "create_walls_from_polyline",
                dryRun,
                level = new { id = ElementIdCompat.GetValue(level.Id), name = level.Name },
                wallType = new { id = ElementIdCompat.GetValue(wallType.Id), name = wallType.Name },
                createdCount = created.Count,
                walls = created
            };
        }

        private static object ChangeWallType(UIApplication app, Params p)
        {
            var ids = NormalizeIds(p.elementIds, max: 2000);
            if (ids.Count == 0) throw new InvalidOperationException("arch-workflows.change_wall_type requires elementIds.");

            var request = new
            {
                elementIds = ids,
                typeId = p.typeId,
                typeName = p.typeName,
                familyName = p.familyName,
                category = "OST_Walls",
                dryRun = p.dryRun ?? false
            };

            var proxied = new RevitBridge.Logic.Handlers.ChangeElementTypeHandler()
                .Handle(app, JsonSerializer.Serialize(request))
                .GetAwaiter().GetResult();

            return new
            {
                status = p.dryRun ?? false ? "Dry Run" : "Applied",
                action = "change_wall_type",
                elementCount = ids.Count,
                result = proxied
            };
        }

        private static object JoinWallGeometry(Document doc, Params p)
        {
            var aId = p.firstElementId.GetValueOrDefault(0);
            var bId = p.secondElementId.GetValueOrDefault(0);
            if (aId <= 0 || bId <= 0)
            {
                var ids = NormalizeIds(p.elementIds, max: 10);
                if (aId <= 0 && ids.Count > 0) aId = ids[0];
                if (bId <= 0 && ids.Count > 1) bId = ids[1];
            }

            if (aId <= 0 || bId <= 0)
                throw new InvalidOperationException("arch-workflows.join_wall_geometry requires firstElementId + secondElementId (or two elementIds).");

            var a = doc.GetElement(ElementIdCompat.Create(aId)) ?? throw new InvalidOperationException($"Element {aId} not found.");
            var b = doc.GetElement(ElementIdCompat.Create(bId)) ?? throw new InvalidOperationException($"Element {bId} not found.");
            if (a is not Wall || b is not Wall) throw new InvalidOperationException("join_wall_geometry currently requires two walls.");

            var mode = (p.mode ?? "join").Trim().ToLowerInvariant();
            var dryRun = p.dryRun ?? false;

            var before = JoinGeometryUtils.AreElementsJoined(doc, a, b);
            var after = before;
            using (var tx = new Transaction(doc, dryRun ? "Arch Workflows - Join Walls (Dry Run)" : "Arch Workflows - Join Walls"))
            {
                tx.Start();
                if (mode == "join")
                {
                    if (!before) JoinGeometryUtils.JoinGeometry(doc, a, b);
                }
                else if (mode == "unjoin")
                {
                    if (before) JoinGeometryUtils.UnjoinGeometry(doc, a, b);
                }
                else if (mode == "toggle")
                {
                    if (before) JoinGeometryUtils.UnjoinGeometry(doc, a, b);
                    else JoinGeometryUtils.JoinGeometry(doc, a, b);
                }
                else
                {
                    throw new InvalidOperationException("join_wall_geometry.mode must be join|unjoin|toggle.");
                }

                after = JoinGeometryUtils.AreElementsJoined(doc, a, b);
                if (dryRun) tx.RollBack();
                else tx.Commit();
            }

            return new
            {
                status = dryRun ? "Dry Run" : "Applied",
                action = "join_wall_geometry",
                dryRun,
                mode,
                firstElementId = aId,
                secondElementId = bId,
                joinedBefore = before,
                joinedAfter = after
            };
        }

        private static object PlaceHostedInstances(UIApplication app, Params p)
        {
            var symbolName = (p.symbolName ?? "").Trim();
            if (symbolName.Length == 0) throw new InvalidOperationException("arch-workflows.place_hosted_instances requires symbolName.");

            var placements = (p.placements ?? new List<PlacementSpec>()).Where(x => x != null).ToList();
            if (placements.Count == 0) throw new InvalidOperationException("arch-workflows.place_hosted_instances requires placements.");

            var dryRun = p.dryRun ?? false;
            var request = new
            {
                levelName = p.levelName,
                familyName = string.IsNullOrWhiteSpace(p.familyName) ? null : p.familyName!.Trim(),
                symbolName,
                dryRun,
                behavior = "bestEffort",
                instances = placements.Select(x => new
                {
                    levelName = p.levelName,
                    x = x.x,
                    y = x.y,
                    z = x.z,
                    rotationDegrees = x.rotationDegrees,
                    hostElementId = x.hostElementId
                }).ToArray()
            };

            var placed = new RevitBridge.Logic.Handlers.PlaceFamiliesHandler()
                .Handle(app, JsonSerializer.Serialize(request))
                .GetAwaiter().GetResult();

            var alignRequests = new List<object>();
            if (!dryRun)
            {
                var doc = app.ActiveUIDocument?.Document;
                var createdByIndex = ReadCreatedElementIdsByIndex(placed);
                for (var i = 0; i < placements.Count; i++)
                {
                    var pl = placements[i];
                    if (!pl.alignToElementId.HasValue || pl.alignToElementId.Value <= 0) continue;
                    if (!createdByIndex.TryGetValue(i, out var createdId) || createdId <= 0) continue;

                    if (doc != null)
                    {
                        var targetElement = doc.GetElement(ElementIdCompat.Create(pl.alignToElementId.Value));
                        if (targetElement is ReferencePlane)
                        {
                            var refAlign = AlignElementToReferencePlane(doc, createdId, pl.alignToElementId.Value);
                            alignRequests.Add(new
                            {
                                placementIndex = i,
                                createdElementId = createdId,
                                alignToElementId = pl.alignToElementId.Value,
                                result = refAlign
                            });
                            continue;
                        }
                    }

                    var alignReq = new RevitBridge.Logic.Handlers.AlignElementsHandler.Params
                    {
                        sourceElementId = createdId,
                        targetElementId = pl.alignToElementId.Value,
                        axis = string.IsNullOrWhiteSpace(pl.alignAxis) ? "viewX" : pl.alignAxis!,
                        viewId = p.viewId,
                        dryRun = false,
                        source = new RevitBridge.Logic.Handlers.AlignElementsHandler.FaceSpec
                        {
                            kind = "face",
                            side = string.IsNullOrWhiteSpace(pl.alignSourceSide) ? "left" : pl.alignSourceSide!
                        },
                        target = new RevitBridge.Logic.Handlers.AlignElementsHandler.FaceSpec
                        {
                            kind = "face",
                            side = string.IsNullOrWhiteSpace(pl.alignTargetSide) ? "left" : pl.alignTargetSide!
                        }
                    };

                    object alignResult;
                    try
                    {
                        alignResult = new RevitBridge.Logic.Handlers.AlignElementsHandler()
                            .Handle(app, JsonSerializer.Serialize(alignReq))
                            .GetAwaiter().GetResult();
                    }
                    catch (Exception ex)
                    {
                        alignResult = new { status = "Error", message = ex.Message };
                    }

                    alignRequests.Add(new
                    {
                        placementIndex = i,
                        createdElementId = createdId,
                        alignToElementId = pl.alignToElementId.Value,
                        result = alignResult
                    });
                }
            }

            return new
            {
                status = dryRun ? "Dry Run" : "Applied",
                action = "place_hosted_instances",
                dryRun,
                symbolName,
                placementCount = placements.Count,
                placeFamiliesResult = placed,
                alignmentResults = alignRequests
            };
        }

        private static object SwapFamilyTypeInView(Document doc, Params p)
        {
            var viewId = p.viewId.GetValueOrDefault(0);
            if (viewId <= 0) throw new InvalidOperationException("arch-workflows.swap_family_type_in_view requires viewId.");

            var view = doc.GetElement(ElementIdCompat.Create(viewId)) as View
                ?? throw new InvalidOperationException($"View {viewId} not found.");

            var targetCategory = ResolveCategory(doc, p.categoryName ?? "OST_Doors")
                ?? throw new InvalidOperationException("Unable to resolve category for swap_family_type_in_view.");

            var newType = ResolveFamilySymbol(doc, p.typeId, p.typeName, p.familyName, targetCategory)
                ?? throw new InvalidOperationException("Unable to resolve destination family type.");

            var sourceTypeId = p.sourceTypeId.GetValueOrDefault(0);
            var sourceTypeName = (p.sourceTypeName ?? "").Trim();
            var max = ClampInt(p.max.GetValueOrDefault(2000), 1, 10000);
            var dryRun = p.dryRun ?? false;

            var all = new FilteredElementCollector(doc, view.Id)
                .OfClass(typeof(FamilyInstance))
                .Cast<FamilyInstance>()
                .Where(fi => fi.Category != null && fi.Category.Id == targetCategory.Id)
                .Take(max)
                .ToList();

            var targets = all.Where(fi =>
            {
                if (sourceTypeId > 0) return ElementIdCompat.GetValue(fi.GetTypeId()) == sourceTypeId;
                if (sourceTypeName.Length == 0) return true;
                var nm = (fi.Symbol?.Name ?? "").Trim();
                return nm.Equals(sourceTypeName, StringComparison.OrdinalIgnoreCase) ||
                       nm.IndexOf(sourceTypeName, StringComparison.OrdinalIgnoreCase) >= 0;
            }).ToList();

            var rows = new List<object>();
            using (var tx = new Transaction(doc, dryRun ? "Arch Workflows - Swap Family Type (Dry Run)" : "Arch Workflows - Swap Family Type"))
            {
                tx.Start();
                foreach (var fi in targets)
                {
                    var beforeType = fi.Symbol?.Name;
                    var beforeTypeId = ElementIdCompat.GetValue(fi.GetTypeId());
                    if (!dryRun)
                    {
                        try { fi.ChangeTypeId(newType.Id); }
                        catch (Exception ex)
                        {
                            rows.Add(new
                            {
                                elementId = ElementIdCompat.GetValue(fi.Id),
                                ok = false,
                                error = ex.Message,
                                beforeTypeId,
                                beforeType
                            });
                            continue;
                        }
                    }

                    rows.Add(new
                    {
                        elementId = ElementIdCompat.GetValue(fi.Id),
                        ok = true,
                        beforeTypeId,
                        beforeType,
                        afterTypeId = ElementIdCompat.GetValue(newType.Id),
                        afterType = newType.Name
                    });
                }

                if (dryRun) tx.RollBack();
                else tx.Commit();
            }

            return new
            {
                status = dryRun ? "Dry Run" : "Applied",
                action = "swap_family_type_in_view",
                dryRun,
                view = new { id = ElementIdCompat.GetValue(view.Id), name = view.Name },
                category = targetCategory.Name,
                destinationType = new { id = ElementIdCompat.GetValue(newType.Id), name = newType.Name, family = newType.FamilyName },
                candidateCount = all.Count,
                targetCount = targets.Count,
                changedCount = rows.Count,
                changes = rows
            };
        }

        private static object CreateModelGroupAndPlace(Document doc, Params p)
        {
            var ids = NormalizeIds(p.elementIds, max: 5000);
            if (ids.Count == 0) throw new InvalidOperationException("arch-workflows.create_model_group_and_place requires elementIds.");
            var dryRun = p.dryRun ?? false;
            var place = p.x.HasValue || p.y.HasValue || p.z.HasValue;
            var placePoint = new XYZ(p.x ?? 0.0, p.y ?? 0.0, p.z ?? 0.0);

            long? groupId = null;
            long? placedId = null;
            string? groupTypeName = null;

            using (var tx = new Transaction(doc, dryRun ? "Arch Workflows - Create Group (Dry Run)" : "Arch Workflows - Create Group"))
            {
                tx.Start();
                var group = doc.Create.NewGroup(ids.Select(ElementIdCompat.Create).ToList());
                var gid = group?.Id;
                groupId = gid == null ? (long?)null : ElementIdCompat.GetValue(gid);
                groupTypeName = group?.GroupType?.Name;

                if (place && group?.GroupType != null)
                {
                    var placed = doc.Create.PlaceGroup(placePoint, group.GroupType);
                    placedId = placed == null ? (long?)null : ElementIdCompat.GetValue(placed.Id);
                }

                if (dryRun) tx.RollBack();
                else tx.Commit();
            }

            return new
            {
                status = dryRun ? "Dry Run" : "Applied",
                action = "create_model_group_and_place",
                dryRun,
                sourceCount = ids.Count,
                groupId,
                groupTypeName,
                placedGroupId = placedId,
                placement = place ? new[] { placePoint.X, placePoint.Y, placePoint.Z } : null
            };
        }

        private static object ArrayElements(Document doc, Params p)
        {
            var ids = NormalizeIds(p.elementIds, max: 2000);
            if (ids.Count == 0) throw new InvalidOperationException("arch-workflows.array_elements requires elementIds.");
            var count = ClampInt(p.count.GetValueOrDefault(1), 1, 200);
            if (count < 2) throw new InvalidOperationException("arch-workflows.array_elements requires count >= 2.");
            var spacing = new XYZ(p.spacingX.GetValueOrDefault(0), p.spacingY.GetValueOrDefault(0), p.spacingZ.GetValueOrDefault(0));
            if (spacing.GetLength() < 1e-9) throw new InvalidOperationException("arch-workflows.array_elements requires non-zero spacingX/Y/Z.");
            var dryRun = p.dryRun ?? false;

            var created = new List<long>();
            using (var tx = new Transaction(doc, dryRun ? "Arch Workflows - Array Elements (Dry Run)" : "Arch Workflows - Array Elements"))
            {
                tx.Start();
                var src = ids.Select(ElementIdCompat.Create).ToList();
                for (var i = 1; i < count; i++)
                {
                    var move = Transform.CreateTranslation(new XYZ(spacing.X * i, spacing.Y * i, spacing.Z * i));
                    var copied = ElementTransformUtils.CopyElements(doc, src, doc, move, new CopyPasteOptions());
                    foreach (var id in copied ?? Array.Empty<ElementId>())
                    {
                        var v = ElementIdCompat.GetValue(id);
                        if (v > 0) created.Add(v);
                    }
                }

                if (dryRun) tx.RollBack();
                else tx.Commit();
            }

            return new
            {
                status = dryRun ? "Dry Run" : "Applied",
                action = "array_elements",
                dryRun,
                sourceCount = ids.Count,
                count,
                spacing = new[] { spacing.X, spacing.Y, spacing.Z },
                copiedCount = created.Count,
                copiedElementIds = created
            };
        }

        private static object MirrorElements(Document doc, Params p)
        {
            var ids = NormalizeIds(p.elementIds, max: 2000);
            if (ids.Count == 0) throw new InvalidOperationException("arch-workflows.mirror_elements requires elementIds.");
            if (p.planeOrigin == null || p.planeNormal == null)
                throw new InvalidOperationException("arch-workflows.mirror_elements requires planeOrigin and planeNormal.");

            var origin = ToXyz(p.planeOrigin);
            var normal = ToXyz(p.planeNormal);
            if (normal.GetLength() < 1e-9) throw new InvalidOperationException("planeNormal cannot be zero.");
            var plane = Plane.CreateByNormalAndOrigin(normal.Normalize(), origin);
            var copy = p.copy ?? false;
            var dryRun = p.dryRun ?? false;

            using (var tx = new Transaction(doc, dryRun ? "Arch Workflows - Mirror Elements (Dry Run)" : "Arch Workflows - Mirror Elements"))
            {
                tx.Start();
                ElementTransformUtils.MirrorElements(doc, ids.Select(ElementIdCompat.Create).ToList(), plane, copy);
                if (dryRun) tx.RollBack();
                else tx.Commit();
            }

            return new
            {
                status = dryRun ? "Dry Run" : "Applied",
                action = "mirror_elements",
                dryRun,
                sourceCount = ids.Count,
                copy,
                plane = new
                {
                    origin = new[] { origin.X, origin.Y, origin.Z },
                    normal = new[] { normal.X, normal.Y, normal.Z }
                }
            };
        }

        private static object CopySamePlace(Document doc, Params p)
        {
            var ids = NormalizeIds(p.elementIds, max: 2000);
            if (ids.Count == 0) throw new InvalidOperationException("arch-workflows.copy_same_place requires elementIds.");
            var dryRun = p.dryRun ?? false;
            var copiedIds = new List<long>();

            using (var tx = new Transaction(doc, dryRun ? "Arch Workflows - Copy Same Place (Dry Run)" : "Arch Workflows - Copy Same Place"))
            {
                tx.Start();
                var copied = ElementTransformUtils.CopyElements(
                    doc,
                    ids.Select(ElementIdCompat.Create).ToList(),
                    doc,
                    Transform.Identity,
                    new CopyPasteOptions());

                foreach (var id in copied ?? Array.Empty<ElementId>())
                {
                    var v = ElementIdCompat.GetValue(id);
                    if (v > 0) copiedIds.Add(v);
                }

                if (dryRun) tx.RollBack();
                else tx.Commit();
            }

            return new
            {
                status = dryRun ? "Dry Run" : "Applied",
                action = "copy_same_place",
                dryRun,
                sourceCount = ids.Count,
                copiedCount = copiedIds.Count,
                copiedElementIds = copiedIds
            };
        }

        private static object CreateReferencePlane(Document doc, View? activeView, Params p)
        {
            var dryRun = p.dryRun ?? false;
            var view = ResolveView(doc, p.viewId) ?? activeView;
            if (view == null) throw new InvalidOperationException("arch-workflows.create_reference_plane requires viewId or an active view.");
            if (p.p1 == null || p.p2 == null) throw new InvalidOperationException("create_reference_plane requires p1 and p2.");

            var p1 = ToXyz(p.p1);
            var p2 = ToXyz(p.p2);
            if (p1.DistanceTo(p2) < 1e-6) throw new InvalidOperationException("create_reference_plane requires distinct p1 and p2.");
            var cut = p.cutVec == null ? XYZ.BasisZ : ToXyz(p.cutVec);
            if (cut.GetLength() < 1e-9) cut = XYZ.BasisZ;
            var name = (p.name ?? "").Trim();

            long? referencePlaneId = null;
            using (var tx = new Transaction(doc, dryRun ? "Arch Workflows - Create Reference Plane (Dry Run)" : "Arch Workflows - Create Reference Plane"))
            {
                tx.Start();
                var rp = CreateReferencePlaneCompat(doc, view, p1, p2, cut)
                    ?? throw new InvalidOperationException("Failed to create reference plane (API mismatch).");
                if (name.Length > 0)
                {
                    try { rp.Name = name; } catch { }
                }
                referencePlaneId = ElementIdCompat.GetValue(rp.Id);
                if (dryRun) tx.RollBack();
                else tx.Commit();
            }

            return new
            {
                status = dryRun ? "Dry Run" : "Applied",
                action = "create_reference_plane",
                dryRun,
                view = new { id = ElementIdCompat.GetValue(view.Id), name = view.Name },
                referencePlaneId,
                name = name.Length == 0 ? null : name,
                p1 = new[] { p1.X, p1.Y, p1.Z },
                p2 = new[] { p2.X, p2.Y, p2.Z }
            };
        }

        private static object PurgeDuplicateLinePatterns(Document doc, Params p)
        {
            var dryRun = p.dryRun ?? false;
            var maxDelete = ClampInt(p.maxDelete.GetValueOrDefault(200), 1, 5000);
            var includeTypesWithDependencies = p.includeTypesWithDependencies ?? false;

            var patterns = new FilteredElementCollector(doc)
                .OfClass(typeof(LinePatternElement))
                .Cast<LinePatternElement>()
                .ToList();

            var grouped = patterns
                .Select(lp => new
                {
                    element = lp,
                    id = ElementIdCompat.GetValue(lp.Id),
                    name = (lp.Name ?? "").Trim(),
                    signature = BuildLinePatternSignature(lp)
                })
                .Where(x => !string.IsNullOrWhiteSpace(x.signature))
                .GroupBy(x => x.signature!, StringComparer.OrdinalIgnoreCase)
                .Where(g => g.Count() > 1)
                .ToList();

            var toDelete = new List<ElementId>();
            var plan = new List<object>();
            foreach (var g in grouped)
            {
                var ordered = g
                    .OrderBy(x => IsPreferredLinePatternName(x.name) ? 0 : 1)
                    .ThenBy(x => x.id)
                    .ToList();
                var keep = ordered.First();
                var duplicates = ordered.Skip(1).Take(maxDelete).ToList();
                foreach (var dup in duplicates)
                {
                    toDelete.Add(dup.element.Id);
                }

                plan.Add(new
                {
                    signature = g.Key,
                    keep = new { id = keep.id, name = keep.name },
                    remove = duplicates.Select(x => new { id = x.id, name = x.name }).ToArray()
                });
            }

            var deleted = new List<long>();
            var failures = new List<object>();
            if (!dryRun && toDelete.Count > 0)
            {
                using (var tx = new Transaction(doc, "Arch Workflows - Purge Duplicate Line Patterns"))
                {
                    tx.Start();
                    foreach (var id in toDelete)
                    {
                        try
                        {
                            if (!includeTypesWithDependencies && IsLinePatternInUse(doc, id))
                            {
                                failures.Add(new { id = ElementIdCompat.GetValue(id), error = "Skipped because pattern appears in use." });
                                continue;
                            }

                            var removed = doc.Delete(id);
                            if (removed == null || removed.Count == 0)
                            {
                                failures.Add(new { id = ElementIdCompat.GetValue(id), error = "Delete returned no removed ids." });
                                continue;
                            }
                            deleted.Add(ElementIdCompat.GetValue(id));
                        }
                        catch (Exception ex)
                        {
                            failures.Add(new { id = ElementIdCompat.GetValue(id), error = ex.Message });
                        }
                    }
                    tx.Commit();
                }
            }

            return new
            {
                status = dryRun ? "Dry Run" : "Applied",
                action = "purge_duplicate_line_patterns",
                dryRun,
                duplicateGroups = grouped.Count,
                plannedDeleteCount = toDelete.Count,
                deletedCount = deleted.Count,
                deletedLinePatternIds = deleted,
                failures,
                groups = plan
            };
        }

        private static object CreateFloorFromWalls(Document doc, Params p)
        {
            var ids = NormalizeIds(p.elementIds, max: 5000);
            if (ids.Count < 3) throw new InvalidOperationException("arch-workflows.create_floor_from_walls requires at least three wall elementIds.");

            var walls = ids
                .Select(id => doc.GetElement(ElementIdCompat.Create(id)) as Wall)
                .Where(w => w != null)
                .Cast<Wall>()
                .ToList();
            if (walls.Count < 3) throw new InvalidOperationException("No sufficient wall elements were resolved from elementIds.");

            var curves = new List<Curve>();
            foreach (var wall in walls)
            {
                if (wall.Location is LocationCurve lc && lc.Curve != null)
                {
                    curves.Add(lc.Curve);
                }
            }
            if (curves.Count < 3) throw new InvalidOperationException("Unable to derive enough wall location curves to create a floor boundary.");

            var loop = BuildLoopFromCurves(curves) ?? throw new InvalidOperationException("Unable to build a closed floor loop from wall location curves.");
            var level = ResolveLevel(doc, p.levelId, p.levelName)
                ?? doc.GetElement(walls[0].LevelId) as Level
                ?? ResolveDefaultLevel(doc)
                ?? throw new InvalidOperationException("Unable to resolve level for floor creation.");
            var floorType = ResolveFloorType(doc, p.floorTypeId, p.floorTypeName)
                ?? throw new InvalidOperationException("Unable to resolve floor type.");
            var dryRun = p.dryRun ?? false;

            long? floorId = null;
            using (var tx = new Transaction(doc, dryRun ? "Arch Workflows - Create Floor From Walls (Dry Run)" : "Arch Workflows - Create Floor From Walls"))
            {
                tx.Start();
                var floor = Floor.Create(doc, new List<CurveLoop> { loop }, floorType.Id, level.Id);
                floorId = floor == null ? (long?)null : ElementIdCompat.GetValue(floor.Id);
                if (dryRun) tx.RollBack();
                else tx.Commit();
            }

            return new
            {
                status = dryRun ? "Dry Run" : "Applied",
                action = "create_floor_from_walls",
                dryRun,
                sourceWallCount = walls.Count,
                level = new { id = ElementIdCompat.GetValue(level.Id), name = level.Name },
                floorType = new { id = ElementIdCompat.GetValue(floorType.Id), name = floorType.Name },
                floorId
            };
        }

        private static object CreateCeilingInRoom(Document doc, Params p)
        {
            var room = ResolveRoom(doc, p.roomId, p.roomNumber)
                ?? throw new InvalidOperationException("arch-workflows.create_ceiling_in_room requires roomId or roomNumber.");
            var level = doc.GetElement(room.LevelId) as Level
                ?? ResolveLevel(doc, p.levelId, p.levelName)
                ?? ResolveDefaultLevel(doc)
                ?? throw new InvalidOperationException("Unable to resolve a level for ceiling creation.");
            var ceilingType = ResolveCeilingType(doc, p.ceilingTypeId, p.ceilingTypeName)
                ?? throw new InvalidOperationException("Unable to resolve ceiling type.");

            var boundary = room.GetBoundarySegments(new SpatialElementBoundaryOptions());
            if (boundary == null || boundary.Count == 0)
                throw new InvalidOperationException("Room has no valid boundary loops for ceiling creation.");

            var loops = new List<CurveLoop>();
            foreach (var loopSegments in boundary)
            {
                var curves = new List<Curve>();
                foreach (var seg in loopSegments ?? Enumerable.Empty<BoundarySegment>())
                {
                    var c = seg.GetCurve();
                    if (c != null) curves.Add(c);
                }
                if (curves.Count >= 3)
                {
                    try { loops.Add(CurveLoop.Create(curves)); } catch { }
                }
            }
            if (loops.Count == 0) throw new InvalidOperationException("Unable to create ceiling loops from room boundaries.");

            var dryRun = p.dryRun ?? false;
            var offset = p.heightFeet;
            long? ceilingId = null;
            bool offsetApplied = false;
            using (var tx = new Transaction(doc, dryRun ? "Arch Workflows - Create Ceiling In Room (Dry Run)" : "Arch Workflows - Create Ceiling In Room"))
            {
                tx.Start();
                var ceiling = Ceiling.Create(doc, loops, ceilingType.Id, level.Id);
                if (ceiling != null && offset.HasValue)
                {
                    offsetApplied = TrySetBuiltInDoubleParameter(ceiling, "CEILING_HEIGHTABOVELEVEL_PARAM", offset.Value);
                }
                ceilingId = ceiling == null ? (long?)null : ElementIdCompat.GetValue(ceiling.Id);
                if (dryRun) tx.RollBack();
                else tx.Commit();
            }

            return new
            {
                status = dryRun ? "Dry Run" : "Applied",
                action = "create_ceiling_in_room",
                dryRun,
                room = new { id = ElementIdCompat.GetValue(room.Id), number = room.Number, name = room.Name },
                level = new { id = ElementIdCompat.GetValue(level.Id), name = level.Name },
                ceilingType = new { id = ElementIdCompat.GetValue(ceilingType.Id), name = ceilingType.Name },
                requestedHeightFeet = offset,
                offsetApplied,
                ceilingId
            };
        }

        private static object CreateRoomsAndTags(Document doc, View? activeView, Params p)
        {
            var points = (p.polyline ?? new List<Point3>()).Where(x => x != null).ToList();
            if (points.Count == 0) throw new InvalidOperationException("arch-workflows.create_rooms_and_tags requires at least one point in polyline.");
            var level = ResolveLevel(doc, p.levelId, p.levelName)
                ?? ResolveDefaultLevel(doc)
                ?? throw new InvalidOperationException("arch-workflows.create_rooms_and_tags requires levelId or levelName (or a resolvable default level).");

            var view = ResolveView(doc, p.viewId) ?? activeView;
            var canTag = (p.createTags ?? true) && view is ViewPlan;
            var dryRun = p.dryRun ?? false;
            var roomIds = new List<long>();
            var roomRows = new List<object>();
            var tagCount = 0;
            var baseName = (p.name ?? "").Trim();

            using (var tx = new Transaction(doc, dryRun ? "Arch Workflows - Create Rooms And Tags (Dry Run)" : "Arch Workflows - Create Rooms And Tags"))
            {
                tx.Start();
                for (var i = 0; i < points.Count; i++)
                {
                    var pt = points[i];
                    var uv = new UV(pt.x, pt.y);
                    Room? room = null;
                    try { room = doc.Create.NewRoom(level, uv); } catch { }
                    if (room == null)
                    {
                        roomRows.Add(new { index = i, ok = false, error = "Room creation failed at point.", point = new[] { pt.x, pt.y, pt.z ?? level.Elevation } });
                        continue;
                    }

                    if (baseName.Length > 0)
                    {
                        try { room.Name = $"{baseName} {i + 1}"; } catch { }
                    }

                    long? tagId = null;
                    if (canTag && view is ViewPlan planView)
                    {
                        try
                        {
                            var tag = doc.Create.NewRoomTag(new LinkElementId(room.Id), uv, planView.Id);
                            if (tag != null)
                            {
                                tagId = ElementIdCompat.GetValue(tag.Id);
                                tagCount++;
                            }
                        }
                        catch { }
                    }

                    var roomId = ElementIdCompat.GetValue(room.Id);
                    if (roomId > 0) roomIds.Add(roomId);
                    roomRows.Add(new
                    {
                        index = i,
                        ok = true,
                        roomId,
                        roomNumber = room.Number,
                        roomName = room.Name,
                        roomTagId = tagId
                    });
                }

                if (dryRun) tx.RollBack();
                else tx.Commit();
            }

            return new
            {
                status = dryRun ? "Dry Run" : "Applied",
                action = "create_rooms_and_tags",
                dryRun,
                level = new { id = ElementIdCompat.GetValue(level.Id), name = level.Name },
                createTags = p.createTags ?? true,
                requestedCount = points.Count,
                createdCount = roomIds.Count,
                taggedCount = tagCount,
                roomIds,
                results = roomRows
            };
        }

        private static object CreateRoomSeparationLines(Document doc, View? activeView, Params p)
        {
            var view = ResolveView(doc, p.viewId) ?? activeView;
            if (view is not ViewPlan viewPlan) throw new InvalidOperationException("arch-workflows.create_room_separation_lines requires a plan view (viewId).");
            var points = (p.polyline ?? new List<Point3>()).Where(x => x != null).ToList();
            if (points.Count < 2) throw new InvalidOperationException("arch-workflows.create_room_separation_lines requires polyline with at least two points.");

            var closeLoop = p.closeLoop ?? false;
            var lines = new List<Line>();
            for (var i = 0; i < points.Count - 1; i++)
            {
                var a = ToXyz(points[i]);
                var b = ToXyz(points[i + 1]);
                if (a.DistanceTo(b) < 1e-6) continue;
                lines.Add(Line.CreateBound(a, b));
            }
            if (closeLoop && points.Count > 2)
            {
                var a = ToXyz(points[points.Count - 1]);
                var b = ToXyz(points[0]);
                if (a.DistanceTo(b) > 1e-6) lines.Add(Line.CreateBound(a, b));
            }
            if (lines.Count == 0) throw new InvalidOperationException("No valid separation segments were derived from polyline.");

            var dryRun = p.dryRun ?? false;
            var created = 0;
            using (var tx = new Transaction(doc, dryRun ? "Arch Workflows - Create Room Separation Lines (Dry Run)" : "Arch Workflows - Create Room Separation Lines"))
            {
                tx.Start();
                var sketchPlane = viewPlan.SketchPlane;
                if (sketchPlane == null)
                {
                    var z = viewPlan.GenLevel?.Elevation ?? points[0].z.GetValueOrDefault(0.0);
                    sketchPlane = SketchPlane.Create(doc, Plane.CreateByNormalAndOrigin(XYZ.BasisZ, new XYZ(0, 0, z)));
                }

                var array = new CurveArray();
                foreach (var l in lines) array.Append(l);
                var modelCurves = doc.Create.NewRoomBoundaryLines(sketchPlane, array, viewPlan);
                created = modelCurves == null ? 0 : modelCurves.Size;
                doc.Regenerate();
                if (dryRun) tx.RollBack();
                else tx.Commit();
            }

            return new
            {
                status = dryRun ? "Dry Run" : "Applied",
                action = "create_room_separation_lines",
                dryRun,
                view = new { id = ElementIdCompat.GetValue(viewPlan.Id), name = viewPlan.Name },
                closeLoop,
                segmentCount = lines.Count,
                createdCount = created,
                recomputedRooms = true
            };
        }

        private static string NormalizeAction(string? raw)
        {
            var a = (raw ?? "").Trim().ToLowerInvariant();
            if (a == "create_walls" || a == "walls_from_polyline") return "create_walls_from_polyline";
            if (a == "swap_type_in_view" || a == "swap_family_type") return "swap_family_type_in_view";
            if (a == "group_and_place" || a == "create_group_and_place") return "create_model_group_and_place";
            if (a == "array" || a == "copy_array") return "array_elements";
            if (a == "mirror") return "mirror_elements";
            if (a == "copy") return "copy_same_place";
            if (a == "create_ref_plane" || a == "reference_plane") return "create_reference_plane";
            if (a == "purge_line_patterns" || a == "purge_duplicate_patterns") return "purge_duplicate_line_patterns";
            if (a == "create_floor") return "create_floor_from_walls";
            if (a == "create_ceiling") return "create_ceiling_in_room";
            if (a == "create_rooms") return "create_rooms_and_tags";
            if (a == "room_separation_lines") return "create_room_separation_lines";
            return a;
        }

        private static List<long> NormalizeIds(List<long>? ids, int max)
        {
            return (ids ?? new List<long>())
                .Where(x => x > 0)
                .Distinct()
                .Take(max)
                .ToList();
        }

        private static int ClampInt(int value, int min, int max)
        {
            if (value < min) return min;
            if (value > max) return max;
            return value;
        }

        private static XYZ ToXyz(Point3 p) => new XYZ(p.x, p.y, p.z ?? 0.0);

        private static Level? ResolveLevel(Document doc, long? levelId, string? levelName)
        {
            if (levelId.HasValue && levelId.Value > 0)
            {
                var byId = doc.GetElement(ElementIdCompat.Create(levelId.Value)) as Level;
                if (byId != null) return byId;
            }

            var name = (levelName ?? "").Trim();
            if (name.Length == 0) return null;
            return new FilteredElementCollector(doc)
                .OfClass(typeof(Level))
                .Cast<Level>()
                .FirstOrDefault(x => string.Equals((x.Name ?? "").Trim(), name, StringComparison.OrdinalIgnoreCase));
        }

        private static Level? ResolveDefaultLevel(Document doc)
        {
            return new FilteredElementCollector(doc)
                .OfClass(typeof(Level))
                .Cast<Level>()
                .OrderBy(x => x.Elevation)
                .FirstOrDefault();
        }

        private static WallType? ResolveWallType(Document doc, long? wallTypeId, string? wallTypeName)
        {
            if (wallTypeId.HasValue && wallTypeId.Value > 0)
            {
                var byId = doc.GetElement(ElementIdCompat.Create(wallTypeId.Value)) as WallType;
                if (byId != null) return byId;
            }

            var query = (wallTypeName ?? "").Trim();
            var all = new FilteredElementCollector(doc)
                .OfClass(typeof(WallType))
                .Cast<WallType>()
                .ToList();
            if (query.Length == 0) return all.FirstOrDefault();

            var exact = all.FirstOrDefault(x => string.Equals((x.Name ?? "").Trim(), query, StringComparison.OrdinalIgnoreCase));
            if (exact != null) return exact;
            return all.FirstOrDefault(x => (x.Name ?? "").IndexOf(query, StringComparison.OrdinalIgnoreCase) >= 0) ?? all.FirstOrDefault();
        }

        private static FloorType? ResolveFloorType(Document doc, long? floorTypeId, string? floorTypeName)
        {
            if (floorTypeId.HasValue && floorTypeId.Value > 0)
            {
                var byId = doc.GetElement(ElementIdCompat.Create(floorTypeId.Value)) as FloorType;
                if (byId != null) return byId;
            }

            var all = new FilteredElementCollector(doc)
                .OfClass(typeof(FloorType))
                .Cast<FloorType>()
                .ToList();
            if (all.Count == 0) return null;
            var query = (floorTypeName ?? "").Trim();
            if (query.Length == 0) return all.FirstOrDefault();
            var exact = all.FirstOrDefault(x => string.Equals((x.Name ?? "").Trim(), query, StringComparison.OrdinalIgnoreCase));
            if (exact != null) return exact;
            return all.FirstOrDefault(x => (x.Name ?? "").IndexOf(query, StringComparison.OrdinalIgnoreCase) >= 0) ?? all.FirstOrDefault();
        }

        private static CeilingType? ResolveCeilingType(Document doc, long? ceilingTypeId, string? ceilingTypeName)
        {
            if (ceilingTypeId.HasValue && ceilingTypeId.Value > 0)
            {
                var byId = doc.GetElement(ElementIdCompat.Create(ceilingTypeId.Value)) as CeilingType;
                if (byId != null) return byId;
            }

            var all = new FilteredElementCollector(doc)
                .OfClass(typeof(CeilingType))
                .Cast<CeilingType>()
                .ToList();
            if (all.Count == 0) return null;
            var query = (ceilingTypeName ?? "").Trim();
            if (query.Length == 0) return all.FirstOrDefault();
            var exact = all.FirstOrDefault(x => string.Equals((x.Name ?? "").Trim(), query, StringComparison.OrdinalIgnoreCase));
            if (exact != null) return exact;
            return all.FirstOrDefault(x => (x.Name ?? "").IndexOf(query, StringComparison.OrdinalIgnoreCase) >= 0) ?? all.FirstOrDefault();
        }

        private static Room? ResolveRoom(Document doc, long? roomId, string? roomNumber)
        {
            if (roomId.HasValue && roomId.Value > 0)
            {
                var byId = doc.GetElement(ElementIdCompat.Create(roomId.Value)) as Room;
                if (byId != null) return byId;
            }

            var query = (roomNumber ?? "").Trim();
            if (query.Length == 0) return null;

            var rooms = new FilteredElementCollector(doc)
                .OfCategory(BuiltInCategory.OST_Rooms)
                .WhereElementIsNotElementType()
                .Cast<Element>()
                .OfType<Room>()
                .ToList();

            var exact = rooms.FirstOrDefault(r => string.Equals((r.Number ?? "").Trim(), query, StringComparison.OrdinalIgnoreCase));
            if (exact != null) return exact;
            return rooms.FirstOrDefault(r => (r.Number ?? "").IndexOf(query, StringComparison.OrdinalIgnoreCase) >= 0);
        }

        private static View? ResolveView(Document doc, long? viewId)
        {
            if (viewId.HasValue && viewId.Value > 0)
            {
                return doc.GetElement(ElementIdCompat.Create(viewId.Value)) as View;
            }
            return null;
        }

        private static Category? ResolveCategory(Document doc, string? token)
        {
            var raw = (token ?? "").Trim();
            if (raw.Length == 0) return null;

            if (raw.StartsWith("OST_", StringComparison.OrdinalIgnoreCase) &&
                Enum.TryParse(raw, true, out BuiltInCategory bic))
            {
                try { return Category.GetCategory(doc, bic); } catch { }
            }

            var fromName = doc.Settings?.Categories?
                .Cast<Category>()
                .FirstOrDefault(c => string.Equals((c.Name ?? "").Trim(), raw, StringComparison.OrdinalIgnoreCase));
            if (fromName != null) return fromName;

            if (raw.Equals("doors", StringComparison.OrdinalIgnoreCase)) return Category.GetCategory(doc, BuiltInCategory.OST_Doors);
            if (raw.Equals("windows", StringComparison.OrdinalIgnoreCase)) return Category.GetCategory(doc, BuiltInCategory.OST_Windows);
            if (raw.Equals("walls", StringComparison.OrdinalIgnoreCase)) return Category.GetCategory(doc, BuiltInCategory.OST_Walls);
            return null;
        }

        private static FamilySymbol? ResolveFamilySymbol(Document doc, long? typeId, string? typeName, string? familyName, Category targetCategory)
        {
            if (typeId.HasValue && typeId.Value > 0)
            {
                var byId = doc.GetElement(ElementIdCompat.Create(typeId.Value)) as FamilySymbol;
                if (byId != null) return byId;
            }

            var typeQuery = (typeName ?? "").Trim();
            var familyQuery = (familyName ?? "").Trim();
            var all = new FilteredElementCollector(doc)
                .OfClass(typeof(FamilySymbol))
                .Cast<FamilySymbol>()
                .Where(x => x.Category != null && x.Category.Id == targetCategory.Id)
                .ToList();

            if (all.Count == 0) return null;
            if (typeQuery.Length == 0 && familyQuery.Length == 0) return all.FirstOrDefault();

            var exact = all.FirstOrDefault(x =>
                (typeQuery.Length == 0 || string.Equals((x.Name ?? "").Trim(), typeQuery, StringComparison.OrdinalIgnoreCase)) &&
                (familyQuery.Length == 0 || string.Equals((x.FamilyName ?? "").Trim(), familyQuery, StringComparison.OrdinalIgnoreCase)));
            if (exact != null) return exact;

            return all.FirstOrDefault(x =>
                (typeQuery.Length == 0 || (x.Name ?? "").IndexOf(typeQuery, StringComparison.OrdinalIgnoreCase) >= 0) &&
                (familyQuery.Length == 0 || (x.FamilyName ?? "").IndexOf(familyQuery, StringComparison.OrdinalIgnoreCase) >= 0));
        }

        private static Dictionary<int, long> ReadCreatedElementIdsByIndex(object placed)
        {
            var map = new Dictionary<int, long>();
            try
            {
                using var doc = JsonDocument.Parse(JsonSerializer.Serialize(placed));
                if (!doc.RootElement.TryGetProperty("results", out var results) || results.ValueKind != JsonValueKind.Array) return map;
                foreach (var row in results.EnumerateArray())
                {
                    if (!row.TryGetProperty("index", out var idx) || idx.ValueKind != JsonValueKind.Number || !idx.TryGetInt32(out var i)) continue;
                    if (!row.TryGetProperty("status", out var st) || st.ValueKind != JsonValueKind.String) continue;
                    if (!string.Equals((st.GetString() ?? "").Trim(), "created", StringComparison.OrdinalIgnoreCase)) continue;
                    if (!row.TryGetProperty("elementId", out var elId) || elId.ValueKind != JsonValueKind.Number || !elId.TryGetInt64(out var id)) continue;
                    map[i] = id;
                }
            }
            catch
            {
                // ignore
            }
            return map;
        }

        private static object AlignElementToReferencePlane(Document doc, long sourceElementId, long referencePlaneId)
        {
            var source = doc.GetElement(ElementIdCompat.Create(sourceElementId));
            var rp = doc.GetElement(ElementIdCompat.Create(referencePlaneId)) as ReferencePlane;
            if (source == null || rp == null)
            {
                return new { status = "Error", message = "Source element or reference plane not found." };
            }

            XYZ? point = null;
            if (source.Location is LocationPoint lp)
            {
                point = lp.Point;
            }
            if (point == null)
            {
                var bb = source.get_BoundingBox(null);
                if (bb != null)
                {
                    point = (bb.Min + bb.Max) * 0.5;
                }
            }
            if (point == null)
            {
                return new { status = "Error", message = "Unable to resolve source element point for reference-plane alignment." };
            }

            var plane = rp.GetPlane();
            var normal = plane.Normal.Normalize();
            var signedDistance = normal.DotProduct(point - plane.Origin);
            var move = normal.Multiply(-signedDistance);
            if (move.GetLength() < 1e-9)
            {
                return new
                {
                    status = "Applied",
                    mode = "reference_plane_projection",
                    moved = false,
                    signedDistanceFeet = signedDistance
                };
            }

            try
            {
                ElementTransformUtils.MoveElement(doc, source.Id, move);
                return new
                {
                    status = "Applied",
                    mode = "reference_plane_projection",
                    moved = true,
                    signedDistanceFeet = signedDistance,
                    move = new[] { move.X, move.Y, move.Z }
                };
            }
            catch (Exception ex)
            {
                return new { status = "Error", message = ex.Message, mode = "reference_plane_projection" };
            }
        }

        private static ReferencePlane? CreateReferencePlaneCompat(Document doc, View view, XYZ bubbleEnd, XYZ freeEnd, XYZ cutVec)
        {
            var creator = doc.Create;
            var t = creator.GetType();

            var m2 = t.GetMethod("NewReferencePlane2", BindingFlags.Instance | BindingFlags.Public, null, new[] { typeof(XYZ), typeof(XYZ), typeof(XYZ), typeof(View) }, null);
            if (m2 != null)
            {
                var obj = m2.Invoke(creator, new object[] { bubbleEnd, freeEnd, cutVec, view });
                return obj as ReferencePlane;
            }

            var m1 = t.GetMethod("NewReferencePlane", BindingFlags.Instance | BindingFlags.Public, null, new[] { typeof(XYZ), typeof(XYZ), typeof(XYZ), typeof(View) }, null);
            if (m1 != null)
            {
                var obj = m1.Invoke(creator, new object[] { bubbleEnd, freeEnd, cutVec, view });
                return obj as ReferencePlane;
            }

            return null;
        }

        private static CurveLoop? BuildLoopFromCurves(IList<Curve> curves, double tol = 1e-4)
        {
            if (curves == null || curves.Count < 3) return null;
            var remaining = curves.Where(c => c != null).ToList();
            if (remaining.Count < 3) return null;

            var chain = new List<Curve> { remaining[0] };
            remaining.RemoveAt(0);

            while (remaining.Count > 0)
            {
                var end = chain[chain.Count - 1].GetEndPoint(1);
                var foundIndex = -1;
                Curve? next = null;
                for (var i = 0; i < remaining.Count; i++)
                {
                    var c = remaining[i];
                    var s = c.GetEndPoint(0);
                    var e = c.GetEndPoint(1);
                    if (s.DistanceTo(end) <= tol)
                    {
                        foundIndex = i;
                        next = c;
                        break;
                    }
                    if (e.DistanceTo(end) <= tol)
                    {
                        foundIndex = i;
                        next = c.CreateReversed();
                        break;
                    }
                }

                if (foundIndex < 0 || next == null) break;
                chain.Add(next);
                remaining.RemoveAt(foundIndex);

                if (chain.Count >= 3)
                {
                    var first = chain[0].GetEndPoint(0);
                    var last = chain[chain.Count - 1].GetEndPoint(1);
                    if (last.DistanceTo(first) <= tol && remaining.Count == 0) break;
                }
            }

            if (chain.Count < 3) return null;
            var start = chain[0].GetEndPoint(0);
            var final = chain[chain.Count - 1].GetEndPoint(1);
            if (final.DistanceTo(start) > tol)
            {
                if (final.DistanceTo(start) > 1.0) return null;
                chain.Add(Line.CreateBound(final, start));
            }

            try { return CurveLoop.Create(chain); }
            catch { return null; }
        }

        private static bool TrySetBuiltInDoubleParameter(Element element, string bipName, double value)
        {
            try
            {
                var bip = (BuiltInParameter)Enum.Parse(typeof(BuiltInParameter), bipName, ignoreCase: true);
                var param = element.get_Parameter(bip);
                if (param == null || param.IsReadOnly) return false;
                if (param.StorageType != StorageType.Double) return false;
                return param.Set(value);
            }
            catch
            {
                return false;
            }
        }

        private static string BuildLinePatternSignature(LinePatternElement element)
        {
            try
            {
                var lp = element.GetLinePattern();
                if (lp == null) return "";
                var segments = lp.GetSegments();
                if (segments == null) return "";

                var parts = new List<string>();
                foreach (var segment in segments)
                {
                    if (segment == null) continue;
                    var segType = "unknown";
                    var len = 0.0;
                    try
                    {
                        var tProp = segment.GetType().GetProperty("Type", BindingFlags.Instance | BindingFlags.Public);
                        segType = tProp?.GetValue(segment, null)?.ToString() ?? segType;
                    }
                    catch { }
                    try
                    {
                        var lProp = segment.GetType().GetProperty("Length", BindingFlags.Instance | BindingFlags.Public);
                        if (lProp?.GetValue(segment, null) is double d) len = d;
                    }
                    catch { }

                    parts.Add($"{segType}:{len.ToString("0.######", CultureInfo.InvariantCulture)}");
                }

                if (parts.Count == 0) return "";
                return string.Join("|", parts);
            }
            catch
            {
                return "";
            }
        }

        private static bool IsPreferredLinePatternName(string? name)
        {
            var n = (name ?? "").Trim();
            if (n.Length == 0) return false;
            return n.StartsWith("<", StringComparison.OrdinalIgnoreCase) ||
                   n.Equals("Solid", StringComparison.OrdinalIgnoreCase) ||
                   n.Equals("Dash", StringComparison.OrdinalIgnoreCase);
        }

        private static bool IsLinePatternInUse(Document doc, ElementId patternId)
        {
            try
            {
                var styles = new FilteredElementCollector(doc)
                    .OfClass(typeof(GraphicsStyle))
                    .Cast<GraphicsStyle>();

                foreach (var gs in styles)
                {
                    var cat = gs.GraphicsStyleCategory;
                    if (cat == null) continue;

                    var projection = cat.GetLinePatternId(GraphicsStyleType.Projection);
                    if (projection != null && projection == patternId) return true;

                    var cut = cat.GetLinePatternId(GraphicsStyleType.Cut);
                    if (cut != null && cut == patternId) return true;
                }
            }
            catch
            {
                // ignore
            }
            return false;
        }
    }
}
