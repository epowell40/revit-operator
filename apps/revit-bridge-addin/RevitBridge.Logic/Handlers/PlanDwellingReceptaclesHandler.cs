using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text.Json;
using System.Threading.Tasks;
using Autodesk.Revit.DB;
using Autodesk.Revit.DB.Architecture;
using Autodesk.Revit.DB.Mechanical;
using Autodesk.Revit.UI;
using RevitBridge.Common;
using RevitBridge.Common.LowVoltage.Core.Geometry;
using RevitBridge.Common.LowVoltage.Skills.DwellingReceptacles;

namespace RevitBridge.Logic.Handlers
{
    public sealed class PlanDwellingReceptaclesHandler : IRequestHandler
    {
        private const double ProjectionToleranceFt = 2.0;

        public sealed class Params
        {
            public string roomNumber { get; set; } = string.Empty;
            public long? viewId { get; set; }
            public List<string>? roomClassifications { get; set; }
            public string? profilePath { get; set; }
            public bool includeExistingReceptacles { get; set; } = true;
        }

        private sealed class WallSpaceBinding
        {
            public string Side { get; set; } = string.Empty;
            public DwellingReceptacleWallSpace WallSpace { get; set; } = new DwellingReceptacleWallSpace();
            public RoomWallResolution Resolution { get; set; } = new RoomWallResolution();
            public RoomWallSegmentGeometry Segment { get; set; } = new RoomWallSegmentGeometry();
        }

        public Task<object> Handle(UIApplication app, string jsonData)
        {
            var p = string.IsNullOrWhiteSpace(jsonData)
                ? new Params()
                : JsonSerializer.Deserialize<Params>(jsonData, new JsonSerializerOptions { PropertyNameCaseInsensitive = true }) ?? new Params();
            var roomNumber = (p.roomNumber ?? string.Empty).Trim();
            if (roomNumber.Length == 0) throw new ArgumentException("roomNumber is required.");

            var uidoc = app.ActiveUIDocument ?? throw new InvalidOperationException("No active Revit document.");
            var doc = uidoc.Document;
            var spatial = HostedPlacementUtil.FindSpatialElement(doc, null, roomNumber)
                ?? throw new InvalidOperationException($"Room/Space '{roomNumber}' was not found.");
            var view = ResolvePowerPlanView(doc, spatial.element, p.viewId)
                ?? throw new InvalidOperationException($"No floor-plan view could be resolved for Room/Space '{roomNumber}'.");
            var profile = LoadProfile(p.profilePath);

            var bindings = BuildWallSpaces(doc, spatial.element, view);
            AddOpeningExclusions(bindings);
            var outsideSpatialNearBoundaryExcludedIds = new List<long>();
            var existing = p.includeExistingReceptacles
                ? FindExistingReceptacles(doc, spatial.element, bindings, outsideSpatialNearBoundaryExcludedIds)
                : new List<DwellingExistingReceptacle>();

            var classifications = p.roomClassifications?.Where(x => !string.IsNullOrWhiteSpace(x)).Select(x => x.Trim()).ToList()
                ?? InferClassifications(spatial.name);
            var plan = DwellingReceptaclePlanner.Plan(new DwellingReceptaclePlanInput
            {
                RoomId = spatial.id,
                RoomNumber = spatial.number,
                RoomName = spatial.name,
                RoomClassifications = classifications,
                WallSpaces = bindings.Select(x => x.WallSpace).ToList(),
                ExistingReceptacles = existing
            }, profile);

            plan.Assumptions.Add("This endpoint plans ordinary perimeter wall-space receptacles only. Kitchens/countertops/islands, bathrooms, laundry, floor receptacles, dedicated equipment outlets, and circuit design remain outside V1 automatic scope.");
            var exemplar = FindPreferredExemplar(doc);
            if (exemplar == null)
            {
                plan.Status = "needs_review";
                plan.ManualReviews.Add(new DwellingReceptacleReviewItem
                {
                    Code = "missing_standard_duplex_exemplar",
                    Message = "No existing standard duplex receptacle exemplar was found in the active model. Load or identify the intended office-standard family/type before placement."
                });
            }
            var dryRunActions = exemplar == null ? new List<object>() : BuildPlacementActions(plan, bindings, exemplar, spatial, view, dryRun: true);
            var applyActions = exemplar == null ? new List<object>() : BuildPlacementActions(plan, bindings, exemplar, spatial, view, dryRun: false);

            return Task.FromResult<object>(new
            {
                schema = "revit-operator.dwelling-receptacle-discovery-plan.v1",
                status = plan.Status,
                room = new
                {
                    id = spatial.id,
                    number = spatial.number,
                    name = spatial.name,
                    kind = spatial.kind,
                    classifications
                },
                view = new
                {
                    id = ElementIdCompat.GetValue(view.Id),
                    name = view.Name,
                    type = view.ViewType.ToString(),
                    levelId = ElementIdCompat.GetValue((view as ViewPlan)?.GenLevel?.Id),
                    levelName = (view as ViewPlan)?.GenLevel?.Name
                },
                profile = new
                {
                    profile.ProfileId,
                    profile.Version,
                    profile.DisplayName,
                    profile.ReferenceEdition,
                    profile.ReferenceSections,
                    profile.MinimumWallSpaceWidthFt,
                    profile.MaximumFloorLineDistanceToReceptacleFt,
                    profile.MaximumReceptacleSpacingFt,
                    profile.DefaultMountingHeightAffFt,
                    profile.PreferredDeviceFamilyIntent,
                    profile.CircuitPolicy,
                    profile.ComplianceDisclaimer
                },
                exemplar = exemplar == null ? null : new
                {
                    id = ElementIdCompat.GetValue(exemplar.Id),
                    family = exemplar.Symbol?.FamilyName,
                    type = exemplar.Symbol?.Name,
                    instanceName = exemplar.Name,
                    selectionBasis = "existing model instance; preferred standard non-GFCI duplex receptacle"
                },
                discovery = new
                {
                    wallSpaceCount = bindings.Count,
                    openingExclusionCount = bindings.Sum(x => x.WallSpace.ExcludedIntervals.Count),
                    existingReceptacleCount = existing.Count,
                    outsideSpatialNearBoundaryExcludedCount = outsideSpatialNearBoundaryExcludedIds.Count,
                    outsideSpatialNearBoundaryExcludedIds,
                    wallSpaces = bindings.Select(x => new
                    {
                        id = x.WallSpace.WallSpaceId,
                        side = x.Side,
                        hostScopedId = x.WallSpace.HostScopedId,
                        hostElementId = x.Resolution.hostElementId,
                        linkedElementId = x.Resolution.linkedElementId,
                        linkedElementName = x.Resolution.boundaryElement?.Name,
                        start = ToPayload(x.Segment.start),
                        end = ToPayload(x.Segment.end),
                        lengthFt = x.Segment.lengthFt,
                        exclusions = x.WallSpace.ExcludedIntervals
                    }).ToList(),
                    existingReceptacles = existing
                },
                plan,
                interaction = new
                {
                    autonomousBeforeApply = true,
                    applyCheckpointCount = applyActions.Count == 0 ? 0 : 1,
                    applyCheckpointLabel = $"Apply {plan.ProposedPlacements.Count} receptacles",
                    noConversationalPermissionLoop = true
                },
                workflow = new
                {
                    dryRunActions,
                    applyActions,
                    verificationActions = BuildVerificationActions(plan, spatial, view),
                    recovery = "If any apply action fails, delete only elementIds returned by completed apply actions, read back Room 403, and report the bounded failure without asking the user to diagnose geometry."
                }
            });
        }

        private static FamilyInstance? FindPreferredExemplar(Document doc)
        {
            return new FilteredElementCollector(doc)
                .OfCategory(BuiltInCategory.OST_ElectricalFixtures)
                .WhereElementIsNotElementType()
                .OfType<FamilyInstance>()
                .Select(instance => new
                {
                    Instance = instance,
                    Text = string.Join(" ", new[] { instance.Symbol?.FamilyName, instance.Symbol?.Name, instance.Name }.Where(x => !string.IsNullOrWhiteSpace(x))).ToLowerInvariant()
                })
                .Where(x => x.Text.Contains("receptacle") && x.Text.Contains("duplex"))
                .Where(x => !x.Text.Contains("gfci") && !x.Text.Contains("counter") && !x.Text.Contains("high voltage"))
                .OrderByDescending(x => x.Text.Contains("standard duplex"))
                .ThenByDescending(x => x.Text.Contains("standard"))
                .ThenBy(x => ElementIdCompat.GetValue(x.Instance.Id))
                .Select(x => x.Instance)
                .FirstOrDefault();
        }

        private static List<object> BuildPlacementActions(
            DwellingReceptaclePlan plan,
            IReadOnlyCollection<WallSpaceBinding> bindings,
            FamilyInstance exemplar,
            ResolvedSpatialContext spatial,
            View view,
            bool dryRun)
        {
            if (!string.Equals(plan.Status, "ready", StringComparison.OrdinalIgnoreCase)) return new List<object>();
            var byWall = bindings.ToDictionary(x => x.WallSpace.WallSpaceId, StringComparer.OrdinalIgnoreCase);
            var actions = new List<object>();
            foreach (var group in plan.ProposedPlacements.GroupBy(x => x.WallSpaceId, StringComparer.OrdinalIgnoreCase).OrderBy(x => x.Key, StringComparer.OrdinalIgnoreCase))
            {
                if (!byWall.TryGetValue(group.Key, out var binding)) continue;
                actions.Add(new
                {
                    method = "POST",
                    path = "/revit/create-similar-from-instance",
                    requires_apply = !dryRun,
                    purpose = dryRun ? $"Dry-run {group.Count()} receptacle placement(s) on {group.Key}" : $"Place {group.Count()} receptacle(s) on {group.Key}",
                    body = new
                    {
                        exemplarElementId = ElementIdCompat.GetValue(exemplar.Id),
                        hostElementId = binding.Resolution.hostElementId,
                        roomId = spatial.id,
                        roomNumber = spatial.number,
                        roomSide = binding.Side,
                        placements = group.Select(item => new
                        {
                            pointXyz = new[] { item.Point.X, item.Point.Y, item.Point.Z },
                            elevationFt = item.Point.Z,
                            label = item.PlacementId
                        }).ToList(),
                        matchOrientationFromSource = false,
                        matchElectricalCircuitFromSource = false,
                        dryRun,
                        includePreviewImage = true,
                        previewViewId = ElementIdCompat.GetValue(view.Id),
                        focusPaddingFt = 6.0
                    }
                });
            }
            return actions;
        }

        private static List<object> BuildVerificationActions(DwellingReceptaclePlan plan, ResolvedSpatialContext spatial, View view)
        {
            var actions = new List<object>
            {
                new
                {
                    method = "POST",
                    path = "/revit/room-contents",
                    requires_apply = false,
                    body = new { roomNumber = spatial.number, categories = new[] { "Electrical Fixtures" }, includeLinked = true, mode = "auto", spatialKindPreference = "space" }
                }
            };
            if (plan.ProposedPlacements.Count == 0) return actions;
            var minX = plan.ProposedPlacements.Min(x => x.Point.X);
            var maxX = plan.ProposedPlacements.Max(x => x.Point.X);
            var minY = plan.ProposedPlacements.Min(x => x.Point.Y);
            var maxY = plan.ProposedPlacements.Max(x => x.Point.Y);
            actions.Add(new
            {
                method = "POST",
                path = "/revit/export-view-region",
                requires_apply = false,
                body = new
                {
                    viewId = ElementIdCompat.GetValue(view.Id),
                    imageMaxSizePx = 2400,
                    includeMapping = true,
                    fileName = $"room-{spatial.number}-dwelling-receptacles",
                    region = new
                    {
                        mode = "center",
                        centerX = (minX + maxX) / 2.0,
                        centerY = (minY + maxY) / 2.0,
                        halfWidth = Math.Max(6.0, ((maxX - minX) / 2.0) + 6.0),
                        halfHeight = Math.Max(6.0, ((maxY - minY) / 2.0) + 6.0)
                    }
                }
            });
            return actions;
        }

        private static DwellingReceptacleProfile LoadProfile(string? requestedPath)
        {
            var path = (requestedPath ?? string.Empty).Trim();
            if (path.Length == 0)
            {
                path = Path.Combine(AppDomain.CurrentDomain.BaseDirectory ?? string.Empty, "Profiles", "PowerOutlets", "dwelling_receptacles.v1.json");
            }
            if (!File.Exists(path)) return new DwellingReceptacleProfile();
            return DwellingReceptacleProfileSerializer.Deserialize(File.ReadAllText(path));
        }

        private static View? ResolvePowerPlanView(Document doc, SpatialElement spatial, long? requestedViewId)
        {
            if (requestedViewId.HasValue && requestedViewId.Value > 0)
            {
                var requested = doc.GetElement(ElementIdCompat.Create(requestedViewId.Value)) as View;
                if (requested != null && !requested.IsTemplate && requested.ViewType == ViewType.FloorPlan) return requested;
                throw new InvalidOperationException("viewId must identify a non-template floor plan.");
            }

            var spatialLevelId = ElementIdCompat.GetValue(spatial.LevelId);
            var active = doc.ActiveView as ViewPlan;
            if (active != null && !active.IsTemplate && active.ViewType == ViewType.FloorPlan && ElementIdCompat.GetValue(active.GenLevel?.Id) == spatialLevelId)
                return active;

            return new FilteredElementCollector(doc)
                .OfClass(typeof(ViewPlan))
                .Cast<ViewPlan>()
                .Where(x => !x.IsTemplate && x.ViewType == ViewType.FloorPlan)
                .Where(x => ElementIdCompat.GetValue(x.GenLevel?.Id) == spatialLevelId)
                .OrderByDescending(x => (x.Name ?? string.Empty).IndexOf("power", StringComparison.OrdinalIgnoreCase) >= 0)
                .ThenBy(x => x.Name, StringComparer.OrdinalIgnoreCase)
                .FirstOrDefault();
        }

        private static List<string> InferClassifications(string roomName)
        {
            var name = (roomName ?? string.Empty).Trim().ToLowerInvariant();
            if (name.Contains("live/work") || name.Contains("live work")) return new List<string> { "live_work_unit" };
            if (name.Contains("bedroom")) return new List<string> { "bedroom" };
            if (name.Contains("living")) return new List<string> { "living_room" };
            if (name.Contains("family")) return new List<string> { "family_room" };
            if (name.Contains("dining")) return new List<string> { "dining_room" };
            if (name.Contains("den")) return new List<string> { "den" };
            if (name.Contains("library")) return new List<string> { "library" };
            if (name.Contains("recreation")) return new List<string> { "recreation_room" };
            if (name.Contains("kitchen")) return new List<string> { "kitchen" };
            if (name.Contains("bath")) return new List<string> { "bathroom" };
            if (name.Contains("laundry")) return new List<string> { "laundry" };
            if (name.Contains("hall")) return new List<string> { "hallway" };
            return new List<string>();
        }

        private static List<WallSpaceBinding> BuildWallSpaces(Document doc, SpatialElement spatial, View view)
        {
            var bindings = new List<WallSpaceBinding>();
            var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            foreach (var side in new[] { "left", "right", "top", "bottom" })
            {
                foreach (var wall in HostedPlacementUtil.ResolveRoomWalls(doc, spatial, view, side, 12))
                {
                    var hostScoped = wall.linkedElementId.HasValue
                        ? $"link:{wall.hostElementId}:{wall.linkedElementId.Value}"
                        : $"host:{wall.hostElementId}";
                    var segmentIndex = 0;
                    foreach (var segment in wall.geometrySegments.Where(x => x.lengthFt > 0.0001))
                    {
                        segmentIndex++;
                        var fingerprint = $"{hostScoped}|{segment.start.X:0.######}|{segment.start.Y:0.######}|{segment.end.X:0.######}|{segment.end.Y:0.######}";
                        var reverse = $"{hostScoped}|{segment.end.X:0.######}|{segment.end.Y:0.######}|{segment.start.X:0.######}|{segment.start.Y:0.######}";
                        if (seen.Contains(fingerprint) || seen.Contains(reverse)) continue;
                        seen.Add(fingerprint);
                        bindings.Add(new WallSpaceBinding
                        {
                            Side = side,
                            Resolution = wall,
                            Segment = segment,
                            WallSpace = new DwellingReceptacleWallSpace
                            {
                                WallSpaceId = $"{side}:{hostScoped}:segment-{segmentIndex}",
                                HostScopedId = hostScoped,
                                Start = ToPoint(segment.start),
                                End = ToPoint(segment.end)
                            }
                        });
                    }
                }
            }
            return bindings.OrderBy(x => x.WallSpace.WallSpaceId, StringComparer.OrdinalIgnoreCase).ToList();
        }

        private static void AddOpeningExclusions(IReadOnlyCollection<WallSpaceBinding> bindings)
        {
            foreach (var group in bindings.GroupBy(x => x.WallSpace.HostScopedId, StringComparer.OrdinalIgnoreCase))
            {
                var wall = group.First().Resolution.boundaryElement as Wall;
                if (wall == null) continue;
                var link = group.First().Resolution.hostElement as RevitLinkInstance;
                var transform = link?.GetTotalTransform();
                IList<ElementId> inserts;
                try { inserts = wall.FindInserts(true, false, false, false); }
                catch { continue; }
                foreach (var insertId in inserts)
                {
                    var insert = wall.Document.GetElement(insertId) as FamilyInstance;
                    if (insert == null) continue;
                    var category = insert.Category?.BuiltInCategory;
                    if (category != BuiltInCategory.OST_Doors && category != BuiltInCategory.OST_Windows) continue;
                    var point = HostedPlacementUtil.TryGetElementPoint(insert);
                    if (point == null) continue;
                    if (transform != null) point = transform.OfPoint(point);
                    var width = ResolveOpeningWidthFt(insert);
                    var best = group
                        .Select(binding => new { Binding = binding, Projection = ProjectToSegment(point, binding.Segment.start, binding.Segment.end) })
                        .OrderBy(x => x.Projection.DistanceFt)
                        .FirstOrDefault();
                    if (best == null || best.Projection.DistanceFt > ProjectionToleranceFt) continue;
                    best.Binding.WallSpace.ExcludedIntervals.Add(new DwellingReceptacleExcludedInterval
                    {
                        StartChainageFt = Math.Max(0, best.Projection.ChainageFt - (width / 2.0)),
                        EndChainageFt = Math.Min(best.Binding.Segment.lengthFt, best.Projection.ChainageFt + (width / 2.0)),
                        Kind = category == BuiltInCategory.OST_Doors ? "door" : "window",
                        SourceScopedId = link == null ? $"host:{ElementIdCompat.GetValue(insert.Id)}" : $"link:{ElementIdCompat.GetValue(link.Id)}:{ElementIdCompat.GetValue(insert.Id)}"
                    });
                }
            }
        }

        private static List<DwellingExistingReceptacle> FindExistingReceptacles(
            Document doc,
            SpatialElement spatial,
            IReadOnlyCollection<WallSpaceBinding> bindings,
            ICollection<long> outsideSpatialNearBoundaryExcludedIds)
        {
            var output = new List<DwellingExistingReceptacle>();
            foreach (var instance in new FilteredElementCollector(doc).OfCategory(BuiltInCategory.OST_ElectricalFixtures).OfClass(typeof(FamilyInstance)).Cast<FamilyInstance>())
            {
                var searchable = string.Join(" ", instance.Symbol?.FamilyName, instance.Symbol?.Name, instance.Name);
                if (searchable.IndexOf("receptacle", StringComparison.OrdinalIgnoreCase) < 0 && searchable.IndexOf("outlet", StringComparison.OrdinalIgnoreCase) < 0) continue;
                var point = HostedPlacementUtil.TryGetElementPoint(instance);
                if (point == null) continue;
                var associatedSpatialId = TryGetAssociatedSpatialId(instance);
                var belongsToTargetSpatial = associatedSpatialId.HasValue
                    ? associatedSpatialId.Value == ElementIdCompat.GetValue(spatial.Id)
                    : HostedPlacementUtil.TryIsPointInSpatial(spatial, point);
                if (!belongsToTargetSpatial)
                {
                    var nearestBoundaryDistance = bindings.Select(x => ProjectToSegment(point, x.Segment.start, x.Segment.end).DistanceFt).DefaultIfEmpty(double.PositiveInfinity).Min();
                    if (nearestBoundaryDistance <= ProjectionToleranceFt)
                        outsideSpatialNearBoundaryExcludedIds.Add(ElementIdCompat.GetValue(instance.Id));
                    continue;
                }
                var best = bindings
                    .Select(binding => new { Binding = binding, Projection = ProjectToSegment(point, binding.Segment.start, binding.Segment.end) })
                    .OrderBy(x => x.Projection.DistanceFt)
                    .FirstOrDefault();
                if (best == null || best.Projection.DistanceFt > ProjectionToleranceFt) continue;
                output.Add(new DwellingExistingReceptacle
                {
                    ElementId = ElementIdCompat.GetValue(instance.Id),
                    WallSpaceId = best.Binding.WallSpace.WallSpaceId,
                    ChainageFt = best.Projection.ChainageFt,
                    CountsTowardGeneralSpacing = true
                });
            }
            return output.OrderBy(x => x.ElementId).ToList();
        }

        private static long? TryGetAssociatedSpatialId(FamilyInstance instance)
        {
            try
            {
                if (instance.Space != null) return ElementIdCompat.GetValue(instance.Space.Id);
            }
            catch { }
            try
            {
                if (instance.Room != null) return ElementIdCompat.GetValue(instance.Room.Id);
            }
            catch { }
            return null;
        }

        private static (double ChainageFt, double DistanceFt) ProjectToSegment(XYZ point, XYZ start, XYZ end)
        {
            var delta = end - start;
            var length = delta.GetLength();
            if (length <= 0.000001) return (0, point.DistanceTo(start));
            var tangent = delta / length;
            var raw = (point - start).DotProduct(tangent);
            var chainage = Math.Max(0, Math.Min(length, raw));
            var projected = start + (tangent * chainage);
            return (chainage, projected.DistanceTo(point));
        }

        private static double ResolveOpeningWidthFt(FamilyInstance insert)
        {
            foreach (var parameter in new[]
            {
                insert.Symbol?.get_Parameter(BuiltInParameter.DOOR_WIDTH),
                insert.Symbol?.LookupParameter("Width"),
                insert.LookupParameter("Width")
            })
            {
                try
                {
                    if (parameter != null && parameter.StorageType == StorageType.Double && parameter.AsDouble() > 0) return parameter.AsDouble();
                }
                catch { }
            }
            return 3.0;
        }

        private static Point3 ToPoint(XYZ point) => new Point3 { X = point.X, Y = point.Y, Z = point.Z };
        private static object ToPayload(XYZ point) => new { x = point.X, y = point.Y, z = point.Z };
    }
}
