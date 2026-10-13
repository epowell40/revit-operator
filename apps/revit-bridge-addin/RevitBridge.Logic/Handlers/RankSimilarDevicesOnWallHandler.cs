using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Text.Json;
using System.Threading.Tasks;
using Autodesk.Revit.DB;
using Autodesk.Revit.DB.Architecture;
using Autodesk.Revit.DB.Electrical;
using Autodesk.Revit.DB.Mechanical;
using Autodesk.Revit.UI;
using RevitBridge.Common;
using RevitBridge.Common.Electrical;
using RevitBridge.Logic.Handlers.Core;
using RevitBridge.Logic.Handlers.MEP;

namespace RevitBridge.Logic.Handlers
{
    public sealed class RankSimilarDevicesOnWallHandler : IRequestHandler
    {
        internal static readonly JsonSerializerOptions JsonOptions = new JsonSerializerOptions { PropertyNameCaseInsensitive = true };
        private const double RequestedRoomSideOffsetToleranceFt = 2.5;

        public sealed class XyzPayload
        {
            public double? x { get; set; }
            public double? y { get; set; }
            public double? z { get; set; }
        }

        public sealed class Params
        {
            public long? roomId { get; set; }
            public string? roomNumber { get; set; }
            public string? roomSide { get; set; }
            public long? referenceElementId { get; set; }
            public XyzPayload? targetPointXyz { get; set; }
            public double? targetX { get; set; }
            public double? targetY { get; set; }
            public double? targetZ { get; set; }
            public double? targetChainageFt { get; set; }
            public double? targetNormalizedChainage { get; set; }
            public string[]? categories { get; set; }
            public string[]? includeKeywords { get; set; }
            public string? sortMode { get; set; }
            public int? maxCandidates { get; set; }
            public long? viewId { get; set; }
            public bool includeRawElementPayload { get; set; } = false;
        }

        private sealed class Candidate
        {
            public Element Element { get; set; } = null!;
            public FamilyInstance? Instance { get; set; }
            public XYZ? Point { get; set; }
            public Element? Host { get; set; }
            public RoomWallResolution? RoomWall { get; set; }
            public HostLocalFrameData? Frame { get; set; }
            public double Score { get; set; }
            public double DistanceToTargetFt { get; set; } = double.PositiveInfinity;
            public bool HostMatchesReference { get; set; }
            public bool HostMatchesRequestedRoomSide { get; set; }
            public bool HostPlacementSupported { get; set; }
            public string Reason { get; set; } = "";
        }

        public Task<object> Handle(UIApplication app, string jsonData)
        {
            var p = string.IsNullOrWhiteSpace(jsonData)
                ? new Params()
                : JsonSerializer.Deserialize<Params>(jsonData, JsonOptions) ?? new Params();

            var uidoc = app.ActiveUIDocument ?? throw new InvalidOperationException("No active Revit document.");
            var doc = uidoc.Document;
            var view = HostedPlacementUtil.ResolveView(doc, doc.ActiveView, p.viewId) ?? throw new InvalidOperationException("No active view.");
            var spatial = HostedPlacementUtil.FindSpatialElement(doc, p.roomId, p.roomNumber);
            if (spatial == null && (p.roomId.HasValue || !string.IsNullOrWhiteSpace(p.roomNumber)))
                throw new InvalidOperationException("Room/space not found.");

            var targetPoint = ResolveTargetPoint(p);
            var reference = p.referenceElementId.HasValue && p.referenceElementId.Value > 0
                ? doc.GetElement(ElementIdCompat.Create(p.referenceElementId.Value))
                : null;
            var referencePoint = HostedPlacementUtil.TryGetElementPoint(reference);
            if (targetPoint == null) targetPoint = referencePoint;

            var requestedSide = HostedPlacementUtil.NormalizeWallSide(p.roomSide);
            var sideWalls = spatial?.element != null && !string.IsNullOrWhiteSpace(requestedSide)
                ? HostedPlacementUtil.ResolveRoomWalls(doc, spatial.element, view, requestedSide, 12)
                : new List<RoomWallResolution>();
            var referenceHostId = reference is FamilyInstance rfi && rfi.Host != null
                ? ElementIdCompat.GetValue(rfi.Host.Id)
                : (long?)null;

            var bics = ResolveBuiltInCategories(p.categories);
            var keywords = NormalizeKeywords(p.includeKeywords);
            var candidates = CollectCandidates(doc, view, bics)
                .Select(e => BuildCandidate(doc, e, spatial?.element, targetPoint, referenceHostId, sideWalls, keywords, p.includeRawElementPayload))
                .Where(x => x != null)
                .Cast<Candidate>()
                .ToList();

            var sortMode = (p.sortMode ?? "").Trim().ToLowerInvariant();
            var ordered = SortCandidates(candidates, sortMode).Take(System.Math.Max(1, System.Math.Min(100, p.maxCandidates ?? 20))).ToList();
            var recommended = ordered.FirstOrDefault();
            var recommendedCreateSimilar = recommended == null ? null : BuildCreateSimilarRequest(recommended, p, targetPoint, requestedSide);

            return Task.FromResult<object>(new
            {
                schema = "operator.similar_device_rank.v1",
                coordinateSystem = new
                {
                    model = "Revit internal XYZ feet; Z is vertical.",
                    hostLocal = "chainageFt is distance along the resolved host wall or room-boundary segment; normalizedChainage is 0..1.",
                    activeView2d = "Use /revit/export-visible-elements or /revit/export-view-region for pixel/view mapping when a redline point is image-based."
                },
                activeView = new
                {
                    id = ElementIdCompat.GetValue(view.Id),
                    name = view.Name,
                    type = view.ViewType.ToString(),
                    scale = SafeInt(() => view.Scale),
                    right = HostedPlacementUtil.BuildVector(SafeXyz(() => view.RightDirection)),
                    up = HostedPlacementUtil.BuildVector(SafeXyz(() => view.UpDirection)),
                    viewDirection = HostedPlacementUtil.BuildVector(SafeXyz(() => view.ViewDirection))
                },
                room = HostedPlacementUtil.BuildResolvedSpatialPayload(spatial, requestedSide),
                request = new
                {
                    roomNumber = p.roomNumber,
                    roomSide = requestedSide,
                    referenceElementId = p.referenceElementId,
                    targetPointXyz = HostedPlacementUtil.BuildVector(targetPoint),
                    sortMode = string.IsNullOrWhiteSpace(sortMode) ? "score_then_distance_then_coordinate" : sortMode,
                    categories = bics.Select(x => x.ToString()).ToList(),
                    includeKeywords = keywords
                },
                requestedRoomSideWalls = sideWalls.Select(w => HostedPlacementUtil.BuildRoomWallHostContextPayload(w)).ToList(),
                recommendedElementId = recommended == null ? (long?)null : ElementIdCompat.GetValue(recommended.Element.Id),
                recommendedCreateSimilarRequest = recommendedCreateSimilar,
                candidates = ordered.Select((c, index) => BuildCandidatePayload(doc, c, index + 1, p.includeRawElementPayload)).ToList(),
                nextTools = new
                {
                    dryRunPlacement = "/revit/create-similar-from-instance",
                    applyPlacement = "/revit/create-similar-from-instance",
                    adjustPlacement = "/revit/adjust-hosted-instance-on-host",
                    verifyPlacement = "/revit/audit-hosted-instance-placement",
                    captureBeforeAfter = "/revit/export-view-region or /revit/highlight-and-export"
                }
            });
        }

        private static XYZ? ResolveTargetPoint(Params p)
        {
            var x = p.targetPointXyz?.x ?? p.targetX;
            var y = p.targetPointXyz?.y ?? p.targetY;
            var z = p.targetPointXyz?.z ?? p.targetZ;
            if (x.HasValue && y.HasValue && z.HasValue) return new XYZ(x.Value, y.Value, z.Value);
            return null;
        }

        private static List<BuiltInCategory> ResolveBuiltInCategories(string[]? raw)
        {
            var values = raw?.Where(x => !string.IsNullOrWhiteSpace(x)).Select(x => x.Trim()).ToList() ?? new List<string>();
            if (values.Count == 0)
            {
                values.Add("OST_ElectricalFixtures");
                values.Add("OST_ElectricalEquipment");
                values.Add("OST_CommunicationDevices");
                values.Add("OST_DataDevices");
                values.Add("OST_FireAlarmDevices");
                values.Add("OST_LightingDevices");
            }

            return values
                .Select(x => Enum.TryParse<BuiltInCategory>(x, true, out var bic) ? (BuiltInCategory?)bic : null)
                .Where(x => x.HasValue)
                .Select(x => x!.Value)
                .Distinct()
                .ToList();
        }

        private static List<string> NormalizeKeywords(string[]? raw)
        {
            var values = raw?.Where(x => !string.IsNullOrWhiteSpace(x)).Select(x => x.Trim().ToLowerInvariant()).ToList() ?? new List<string>();
            if (values.Count == 0) values.AddRange(new[] { "receptacle", "outlet", "duplex", "power", "device" });
            return values.Distinct(StringComparer.OrdinalIgnoreCase).ToList();
        }

        private static IEnumerable<Element> CollectCandidates(Document doc, View view, IReadOnlyList<BuiltInCategory> bics)
        {
            FilteredElementCollector collector;
            try { collector = new FilteredElementCollector(doc, view.Id).WhereElementIsNotElementType(); }
            catch { collector = new FilteredElementCollector(doc).WhereElementIsNotElementType(); }

            if (bics.Count > 0)
            {
                var ids = bics.Select(x => ElementIdCompat.Create((long)x)).ToList();
                collector = collector.WherePasses(new ElementMulticategoryFilter(ids));
            }

            return collector.OfClass(typeof(FamilyInstance)).Cast<Element>();
        }

        private static Candidate? BuildCandidate(
            Document doc,
            Element e,
            SpatialElement? spatial,
            XYZ? targetPoint,
            long? referenceHostId,
            IReadOnlyList<RoomWallResolution> sideWalls,
            IReadOnlyList<string> keywords,
            bool includeRawElementPayload)
        {
            var fi = e as FamilyInstance;
            var point = HostedPlacementUtil.TryGetElementPoint(e);
            if (spatial != null && !IsInSpatial(fi, point, spatial)) return null;
            if (!MatchesKeyword(doc, e, keywords)) return null;

            var host = fi?.Host;
            var hostId = host == null ? (long?)null : ElementIdCompat.GetValue(host.Id);
            var roomWall = ResolveBestRoomSideWallForCandidate(host, point, sideWalls);
            if (roomWall == null && host != null)
                roomWall = HostedPlacementUtil.ResolveRoomWallForHost(
                    doc,
                    doc.ActiveView,
                    host,
                    spatial == null ? null : ElementIdCompat.GetValue(spatial.Id),
                    HostedPlacementUtil.GetSpatialNumber(spatial),
                    null);

            var frame = HostedPlacementUtil.BuildHostLocalFrameData(host, roomWall, point);
            var distance = targetPoint != null && point != null ? point.DistanceTo(targetPoint) : double.PositiveInfinity;
            var hostMatchesReference = referenceHostId.HasValue && hostId.HasValue && referenceHostId.Value == hostId.Value;
            var hostMatchesSide =
                sideWalls.Count > 0 &&
                frame != null &&
                frame.offsetFromCurveFt <= RequestedRoomSideOffsetToleranceFt;
            var supported = host != null && HostedPlacementUtil.IsSupportedPlacementHost(host);

            var score = 0.0;
            if (hostMatchesReference) score += 80.0;
            if (hostMatchesSide) score += 70.0;
            if (supported) score += 25.0;
            if (frame != null) score += 15.0;
            if (targetPoint != null && point != null) score += Math.Max(0.0, 30.0 - Math.Min(30.0, distance));

            var reasons = new List<string>();
            if (hostMatchesReference) reasons.Add("same_host_as_reference");
            if (hostMatchesSide) reasons.Add("on_requested_room_side");
            if (supported) reasons.Add("host_supports_native_placement");
            if (frame != null) reasons.Add("host_local_chainage_available");
            if (targetPoint != null && point != null) reasons.Add($"distance_to_target_ft={distance.ToString("0.###", CultureInfo.InvariantCulture)}");

            return new Candidate
            {
                Element = e,
                Instance = fi,
                Point = point,
                Host = host,
                RoomWall = roomWall,
                Frame = frame,
                Score = score,
                DistanceToTargetFt = distance,
                HostMatchesReference = hostMatchesReference,
                HostMatchesRequestedRoomSide = hostMatchesSide,
                HostPlacementSupported = supported,
                Reason = string.Join(",", reasons)
            };
        }

        private static RoomWallResolution? ResolveBestRoomSideWallForCandidate(
            Element? host,
            XYZ? point,
            IReadOnlyList<RoomWallResolution> sideWalls)
        {
            if (host == null || point == null || sideWalls.Count == 0) return null;
            return sideWalls
                .Select(wall => new
                {
                    Wall = wall,
                    Frame = HostedPlacementUtil.BuildHostLocalFrameData(host, wall, point)
                })
                .Where(x => x.Frame != null)
                .OrderBy(x => x.Frame!.offsetFromCurveFt)
                .ThenByDescending(x => x.Wall.supportsPlacement)
                .Select(x => x.Wall)
                .FirstOrDefault();
        }

        private static bool IsInSpatial(FamilyInstance? fi, XYZ? point, SpatialElement spatial)
        {
            try
            {
                if (fi?.Room != null && fi.Room.Id == spatial.Id) return true;
            }
            catch { }
            try
            {
                if (fi?.Space != null && fi.Space.Id == spatial.Id) return true;
            }
            catch { }

            if (point == null) return false;
            try
            {
                if (spatial is Room room) return room.IsPointInRoom(point);
                if (spatial is Space space) return space.IsPointInSpace(point);
            }
            catch { }
            return false;
        }

        private static bool MatchesKeyword(Document doc, Element e, IReadOnlyList<string> keywords)
        {
            if (keywords.Count == 0) return true;
            HostedPlacementUtil.TryGetTypeInfo(doc, e, out _, out var typeName, out var familyName);
            var haystack = string.Join(" ", new[]
            {
                e.Name,
                familyName,
                typeName,
                e.Category?.Name,
                e.LookupParameter("Description")?.AsString(),
                e.LookupParameter("Type Comments")?.AsString(),
                e.LookupParameter("Comments")?.AsString()
            }).ToLowerInvariant();
            return keywords.Any(k => haystack.Contains(k));
        }

        private static IEnumerable<Candidate> SortCandidates(IReadOnlyList<Candidate> candidates, string sortMode)
        {
            if (sortMode == "coordinate_x" || sortMode == "x")
                return candidates.OrderBy(x => x.Point?.X ?? double.MaxValue).ThenBy(x => x.Point?.Y ?? double.MaxValue);
            if (sortMode == "coordinate_y" || sortMode == "y" || sortMode == "smallest_y_then_x")
                return candidates.OrderBy(x => x.Point?.Y ?? double.MaxValue).ThenBy(x => x.Point?.X ?? double.MaxValue);
            if (sortMode == "chainage")
                return candidates.OrderBy(x => x.Frame?.chainageFt ?? double.MaxValue);

            return candidates
                .OrderByDescending(x => x.Score)
                .ThenBy(x => x.DistanceToTargetFt)
                .ThenBy(x => x.Point?.Y ?? double.MaxValue)
                .ThenBy(x => x.Point?.X ?? double.MaxValue);
        }

        private static object BuildCandidatePayload(Document doc, Candidate c, int rank, bool includeRawElementPayload)
        {
            HostedPlacementUtil.TryGetTypeInfo(doc, c.Element, out var typeId, out var typeName, out var familyName);
            var raw = includeRawElementPayload ? DatasetExportUtil.BuildCommonElementPayload(doc, c.Element) : null;
            return new
            {
                rank,
                score = c.Score,
                reason = c.Reason,
                elementId = ElementIdCompat.GetValue(c.Element.Id),
                category = c.Element.Category?.Name,
                familyName,
                typeName,
                typeId,
                location = HostedPlacementUtil.BuildVector(c.Point),
                host = HostedPlacementUtil.BuildPlacementHostPayload(c.Host),
                hostMatchesReference = c.HostMatchesReference,
                hostMatchesRequestedRoomSide = c.HostMatchesRequestedRoomSide,
                hostPlacementSupported = c.HostPlacementSupported,
                hostLocalFrame = HostedPlacementUtil.BuildHostLocalFramePayload(c.Frame, c.Element),
                orientation = HostedPlacementUtil.BuildOrientationPayload(c.Element),
                electricalCircuit = HostedPlacementUtil.BuildElectricalCircuitAuditPayload(c.Instance),
                rawElementPayload = raw
            };
        }

        private static object BuildCreateSimilarRequest(Candidate c, Params p, XYZ? targetPoint, string? requestedSide)
        {
            var placement = new Dictionary<string, object?>();
            var hasExplicitTarget = false;
            var targetSource = "";
            if (p.targetChainageFt.HasValue)
            {
                placement["targetChainageFt"] = p.targetChainageFt.Value;
                hasExplicitTarget = true;
                targetSource = "request_target_chainage";
            }
            else if (p.targetNormalizedChainage.HasValue)
            {
                placement["targetNormalizedChainage"] = p.targetNormalizedChainage.Value;
                hasExplicitTarget = true;
                targetSource = "request_target_normalized_chainage";
            }
            else if (targetPoint != null)
            {
                placement["pointXyz"] = new[] { targetPoint.X, targetPoint.Y, targetPoint.Z };
                hasExplicitTarget = true;
                targetSource = "request_target_point";
            }
            else if (TryBuildNonOverlapHostLocalTarget(c.Frame, out var fallbackChainageFt, out var fallbackNormalizedChainage))
            {
                placement["targetChainageFt"] = fallbackChainageFt;
                placement["targetNormalizedChainage"] = fallbackNormalizedChainage;
                placement["label"] = "ranked host-local fallback";
                hasExplicitTarget = true;
                targetSource = "ranked_host_local_nonoverlap_fallback";
            }

            var body = new Dictionary<string, object?>
            {
                ["exemplarElementId"] = ElementIdCompat.GetValue(c.Element.Id),
                ["hostElementId"] = c.Host == null ? null : ElementIdCompat.GetValue(c.Host.Id),
                ["roomId"] = p.roomId,
                ["roomNumber"] = p.roomNumber,
                ["roomSide"] = requestedSide,
                ["placements"] = placement.Count > 0 ? new[] { placement } : null,
                ["matchOrientationFromSource"] = true,
                ["copyRotation"] = true,
                ["copyFacingHandState"] = true,
                ["matchElectricalCircuitFromSource"] = true,
                ["requireElectricalCircuitMatch"] = false,
                ["requiresExplicitTarget"] = !hasExplicitTarget,
                ["targetSource"] = string.IsNullOrWhiteSpace(targetSource) ? null : targetSource,
                ["notes"] = hasExplicitTarget
                    ? (targetSource == "ranked_host_local_nonoverlap_fallback"
                        ? "Ranking supplied a preview-safe non-overlapping host-local target because no exact redline pick was available. Dry-run and verify before applying."
                        : null)
                    : "Ranking found the exemplar, but no target point/chainage was supplied and no host-local fallback could be computed. Do not apply create-similar until a non-overlapping target is provided.",
                ["includePreviewImage"] = true,
                ["dryRun"] = true
            };

            return body;
        }

        private static bool TryBuildNonOverlapHostLocalTarget(
            HostLocalFrameData? frame,
            out double targetChainageFt,
            out double targetNormalizedChainage)
        {
            targetChainageFt = 0.0;
            targetNormalizedChainage = 0.0;
            if (frame == null) return false;
            var curveLength = frame.curveLengthFt;
            var anchor = frame.chainageFt;
            if (double.IsNaN(curveLength) || double.IsInfinity(curveLength) || curveLength <= 1.5) return false;
            if (double.IsNaN(anchor) || double.IsInfinity(anchor)) return false;

            var margin = Math.Min(1.0, Math.Max(0.25, curveLength * 0.10));
            var minTarget = margin;
            var maxTarget = Math.Max(minTarget, curveLength - margin);
            var spacing = curveLength >= 8.0 ? 3.0 : Math.Max(1.0, curveLength * 0.25);
            var candidates = new List<double>();

            for (var step = 1; step <= Math.Ceiling(curveLength / spacing) + 2; step++)
            {
                candidates.Add(anchor - spacing * step);
                candidates.Add(anchor + spacing * step);
            }

            candidates.Add(minTarget + (maxTarget - minTarget) * 0.25);
            candidates.Add(minTarget + (maxTarget - minTarget) * 0.50);
            candidates.Add(minTarget + (maxTarget - minTarget) * 0.75);

            var rankedCandidates = candidates
                .Where(x => !double.IsNaN(x) && !double.IsInfinity(x))
                .Where(x => x >= minTarget && x <= maxTarget)
                .Where(x => Math.Abs(x - anchor) >= 0.75)
                .OrderBy(x => Math.Abs(x - anchor))
                .ToList();
            if (rankedCandidates.Count == 0) return false;
            var selected = rankedCandidates[0];

            targetChainageFt = Math.Round(selected, 6);
            targetNormalizedChainage = Math.Round(Math.Max(0.0, Math.Min(1.0, selected / curveLength)), 6);
            return true;
        }

        private static int? SafeInt(Func<int> f)
        {
            try { return f(); } catch { return null; }
        }

        private static XYZ? SafeXyz(Func<XYZ> f)
        {
            try { return f(); } catch { return null; }
        }
    }

    public sealed class AssignElectricalCircuitHandler : IRequestHandler
    {
        private sealed class NativePowerCircuitReadback
        {
            public long SystemElementId { get; set; }
            public string SystemType { get; set; } = string.Empty;
            public List<long> MemberElementIds { get; set; } = new List<long>();
            public long? PanelElementId { get; set; }
            public string PanelName { get; set; } = string.Empty;
            public string CircuitNumber { get; set; } = string.Empty;
            public double? TrueLoadInternal { get; set; }
            public double? ApparentLoadInternal { get; set; }
            public double? VoltageInternal { get; set; }
            public int? Poles { get; set; }
        }

        private sealed class PanelScheduleSlotReadback
        {
            public long ScheduleElementId { get; set; }
            public bool ScheduleCreated { get; set; }
            public int TargetSlotNumber { get; set; }
            public int SourceRow { get; set; }
            public int SourceColumn { get; set; }
            public int TargetRow { get; set; }
            public int TargetColumn { get; set; }
            public bool TargetContainsExactSystem { get; set; }
            public string ActualCircuitNumber { get; set; } = string.Empty;
        }

        public sealed class Params
        {
            public long[]? elementIds { get; set; }
            public string? panelName { get; set; }
            public string? circuitNumber { get; set; }
            public long? sourceElementId { get; set; }
            public string? createSystemType { get; set; }
            public long? electricalConnectorId { get; set; }
            public long? electricalSystemId { get; set; }
            public long? panelElementId { get; set; }
            public int? targetPanelSlotNumber { get; set; }
            public string? expectedCircuitNumber { get; set; }
            public bool dryRun { get; set; } = true;
            public bool confirm { get; set; } = false;
            public bool parameterOnlyFallback { get; set; } = false;
        }

        public Task<object> Handle(UIApplication app, string jsonData)
        {
            return Task.FromResult(NativeMutationPreflightBoundary.Execute(enterNativeScope =>
            {
                var p = string.IsNullOrWhiteSpace(jsonData) ? new Params()
                    : JsonSerializer.Deserialize<Params>(jsonData, RankSimilarDevicesOnWallHandler.JsonOptions) ?? new Params();
                CircuitMatchPolicy.RequireNativeAssignmentMode(p.sourceElementId, p.electricalSystemId,
                    p.createSystemType, p.parameterOnlyFallback, p.panelName, p.circuitNumber);
                var doc = app.ActiveUIDocument?.Document ?? throw new InvalidOperationException("No active Revit document.");
                var ids = (p.elementIds ?? Array.Empty<long>()).ToList();
                CircuitMatchPolicy.RequireNativeMemberBatch(ids);
                if (p.sourceElementId.HasValue)
                {
                    CircuitMatchPolicy.RequireSourceAssignmentRequest(p.sourceElementId.Value, ids,
                        p.electricalSystemId.HasValue || !string.IsNullOrWhiteSpace(p.createSystemType) ||
                        p.targetPanelSlotNumber.HasValue || p.electricalConnectorId.HasValue);
                    var exactSource = doc.GetElement(ElementIdCompat.Create(p.sourceElementId.Value))
                        ?? throw new InvalidOperationException($"source_element_not_found:{p.sourceElementId}");
                    return ReassignToSourcePowerCircuit(app, doc, p, ids, exactSource, enterNativeScope);
                }
                if (p.electricalSystemId.HasValue)
                    return MoveExistingPowerCircuit(app, doc, p, ids, enterNativeScope);
                return CreateNewPowerCircuit(app, doc, p, ids, enterNativeScope);
            }));
        }

        private static object ReassignToSourcePowerCircuit(UIApplication app, Document doc, Params p,
            List<long> targetElementIds, Element source, Action enterNativeScope)
        {
            var sourceInstance = source as FamilyInstance
                ?? throw new InvalidOperationException($"source_element_not_family_instance:{p.sourceElementId}");
            var sourcePowerSystemIds = HostedPlacementUtil.GetPowerElectricalSystemIds(sourceInstance);
            if (sourcePowerSystemIds.Count != 1)
                throw new InvalidOperationException($"source_element_requires_one_power_system:{p.sourceElementId}:found={sourcePowerSystemIds.Count}");
            var sourceSystemId = sourcePowerSystemIds[0];
            var sourceSystem = doc.GetElement(ElementIdCompat.Create(sourceSystemId)) as ElectricalSystem
                ?? throw new InvalidOperationException($"source_power_system_not_found:{sourceSystemId}");
            var targets = targetElementIds.Select(id => doc.GetElement(ElementIdCompat.Create(id)) as FamilyInstance
                ?? throw new InvalidOperationException($"target_element_not_family_instance:{id}")).ToList();
            var beforeSourceReadback = ReadNativePowerCircuit(sourceSystem);
            var expectedPanelElementId = p.panelElementId ?? beforeSourceReadback.PanelElementId;
            if (p.panelElementId.HasValue && !CircuitMatchPolicy.HasExactOptionalElementIdentity(p.panelElementId, beforeSourceReadback.PanelElementId))
                throw new InvalidOperationException($"source_power_circuit_panel_mismatch:expected={p.panelElementId}:actual={beforeSourceReadback.PanelElementId}");
            if (!string.IsNullOrWhiteSpace(p.expectedCircuitNumber) &&
                !string.Equals(beforeSourceReadback.CircuitNumber, p.expectedCircuitNumber.Trim(), StringComparison.OrdinalIgnoreCase))
                throw new InvalidOperationException($"source_power_circuit_number_mismatch:expected={p.expectedCircuitNumber.Trim()}:actual={beforeSourceReadback.CircuitNumber}");
            if (!p.dryRun && !p.confirm) throw new InvalidOperationException("source_power_circuit_reassignment_requires_confirm_true");
            var beforeMemberships = targets.ToDictionary(instance => ElementIdCompat.GetValue(instance.Id),
                instance => (IReadOnlyList<long>)HostedPlacementUtil.GetPowerElectricalSystemIds(instance).OrderBy(id => id).ToList());
            var expectedFinalMembers = beforeSourceReadback.MemberElementIds.Concat(targetElementIds).Distinct().OrderBy(id => id).ToList();
            var warnings = new List<string>();
            var nativeFailures = new List<CapturedFailure>();
            enterNativeScope();
            var result = NativeTransactionGroup.Execute(app, doc, "Reassign and Verify Source Electrical Circuit", () =>
            {
                var targetResults = new List<object>();
                using (var tx = new Transaction(doc, "Reassign Electrical Circuit From Source"))
                {
                    if (tx.Start() != TransactionStatus.Started) throw new InvalidOperationException("source_power_circuit_reassignment_transaction_not_started");
                    tx.SetFailureHandlingOptions(FailureHandlingUtil.ConfigureFailureCapture(tx, nativeFailures,
                        rollbackOnErrors: true, deleteWarnings: true));
                    foreach (var target in targets)
                    {
                        var targetId = ElementIdCompat.GetValue(target.Id);
                        var before = HostedPlacementUtil.BuildElectricalCircuitAuditPayload(target);
                        var ok = HostedPlacementUtil.TryReassignElectricalCircuitFromSource(source, target, true, warnings, out var detail);
                        if (!ok || !CircuitMatchPolicy.HasExactMembership(sourceSystemId, HostedPlacementUtil.GetPowerElectricalSystemIds(target)))
                            throw new InvalidOperationException($"exact_source_power_system_assignment_failed:{targetId}:{detail}");
                        targetResults.Add(new { elementId = targetId, ok = true, action = "match_source_electrical_system", detail,
                            before, after = HostedPlacementUtil.BuildElectricalCircuitAuditPayload(target) });
                    }
                    doc.Regenerate();
                    VerifyNativePowerCircuitReadback(ReadNativePowerCircuit(sourceSystem), expectedFinalMembers, expectedPanelElementId);
                    var committed = tx.Commit();
                    if (committed != TransactionStatus.Committed) throw new InvalidOperationException($"source_power_circuit_reassignment_transaction_not_committed:{committed}");
                    if (FailureHandlingUtil.HasErrors(nativeFailures)) throw new InvalidOperationException("source_power_circuit_reassignment_native_failure");
                }
                var transient = ReadNativePowerCircuit(doc.GetElement(ElementIdCompat.Create(sourceSystemId)) as ElectricalSystem
                    ?? throw new InvalidOperationException($"source_power_circuit_missing_after_commit:{sourceSystemId}"));
                VerifyNativePowerCircuitReadback(transient, expectedFinalMembers, expectedPanelElementId);
                if (!string.IsNullOrWhiteSpace(p.expectedCircuitNumber) && !string.Equals(transient.CircuitNumber, p.expectedCircuitNumber.Trim(), StringComparison.OrdinalIgnoreCase))
                    throw new InvalidOperationException($"source_power_circuit_number_mismatch_after_reassignment:expected={p.expectedCircuitNumber.Trim()}:actual={transient.CircuitNumber}");
                return new Dictionary<string, object?> { ["results"] = targetResults,
                    ["nativeCircuitReadback"] = NativePowerCircuitReadbackPayload(transient), ["verifiedMemberElementIds"] = expectedFinalMembers };
            }, p.dryRun ? NativeTransactionDisposition.Rollback : NativeTransactionDisposition.Commit);
            var receipt = (OperatorNativeTransactionReceipt)result["transaction"]!;
            result["schema"] = "operator.assign_electrical_circuit.v5";
            result["mode"] = "strict_exact_source_power_system";
            result["sourceElementId"] = p.sourceElementId;
            result["electricalSystemId"] = sourceSystemId;
            result["panelElementId"] = expectedPanelElementId;
            result["expectedCircuitNumber"] = p.expectedCircuitNumber;
            result["dryRun"] = p.dryRun;
            result["transactionGroupRolledBack"] = receipt.Status == "rolled_back";
            result["rollbackVerified"] = false;
            result["previewExecuted"] = false;
            result["applied"] = receipt.CommittedValue;
            if (p.dryRun && receipt.Status == "rolled_back" && result["success"] is true)
            {
                try
                {
                    var restored = ReadNativePowerCircuit(doc.GetElement(ElementIdCompat.Create(sourceSystemId)) as ElectricalSystem
                        ?? throw new InvalidOperationException($"source_power_circuit_missing_after_rollback:{sourceSystemId}"));
                    VerifyNativePowerCircuitReadback(restored, beforeSourceReadback.MemberElementIds, beforeSourceReadback.PanelElementId);
                    if (!string.Equals(restored.CircuitNumber, beforeSourceReadback.CircuitNumber, StringComparison.OrdinalIgnoreCase) ||
                        targets.Any(target => !beforeMemberships[ElementIdCompat.GetValue(target.Id)].SequenceEqual(
                            HostedPlacementUtil.GetPowerElectricalSystemIds(target).OrderBy(id => id))))
                        throw new InvalidOperationException("source_power_circuit_reassignment_rollback_verification_failed");
                    result["rollbackVerified"] = true;
                    result["previewExecuted"] = true;
                }
                catch (Exception error) { result["success"] = false; result["error"] = error.Message; }
            }
            else if (!p.dryRun)
            {
                OperatorNativeTransactionExecution.ReadCommitted(result, () =>
                {
                    var persisted = ReadNativePowerCircuit(doc.GetElement(ElementIdCompat.Create(sourceSystemId)) as ElectricalSystem
                        ?? throw new InvalidOperationException($"source_power_circuit_missing_after_group_commit:{sourceSystemId}"));
                    VerifyNativePowerCircuitReadback(persisted, expectedFinalMembers, expectedPanelElementId);
                    if (targets.Any(target => !CircuitMatchPolicy.HasExactMembership(sourceSystemId, HostedPlacementUtil.GetPowerElectricalSystemIds(target))) ||
                        (!string.IsNullOrWhiteSpace(p.expectedCircuitNumber) && !string.Equals(persisted.CircuitNumber, p.expectedCircuitNumber.Trim(), StringComparison.OrdinalIgnoreCase)))
                        throw new InvalidOperationException("source_power_circuit_persisted_readback_mismatch");
                    return new Dictionary<string, object?> { ["nativeCircuitReadback"] = NativePowerCircuitReadbackPayload(persisted) };
                });
            }
            warnings.AddRange(nativeFailures.Where(f => string.Equals(f.severity, "warning", StringComparison.OrdinalIgnoreCase))
                .Select(f => f.message).Where(message => !string.IsNullOrWhiteSpace(message)).Distinct());
            result["warnings"] = warnings;
            result["nativeFailures"] = nativeFailures;
            var checkedOutcome = result["success"] is true && (p.dryRun ? result["rollbackVerified"] is true : result.TryGetValue("verified", out var v) && v is true);
            result["verification"] = new { nativePowerCircuit = checkedOutcome, exactTargetSystemIdentity = checkedOutcome,
                exactMemberSet = checkedOutcome, exactPanelIdentity = checkedOutcome, expectedCircuitNumberMatched = checkedOutcome,
                rollbackVerified = p.dryRun ? result["rollbackVerified"] : null, complianceEvaluated = false };
            result["status"] = OperatorNativeTransactionExecution.OutcomeStatus(result, "Applied", "Planned");
            result["limitation"] = "Reassigns existing family instances into one native source PowerCircuit; code compliance and engineering sizing require separate checks.";
            return result;
        }

        private static object MoveExistingPowerCircuit(UIApplication app, Document doc, Params p,
            List<long> expectedMemberIds, Action enterNativeScope)
        {
            CircuitMatchPolicy.RequireCircuitMoveRequest(p.electricalSystemId!.Value, p.panelElementId,
                p.targetPanelSlotNumber, expectedMemberIds, p.sourceElementId.HasValue ||
                !string.IsNullOrWhiteSpace(p.createSystemType) || p.parameterOnlyFallback ||
                p.electricalConnectorId.HasValue || !string.IsNullOrWhiteSpace(p.panelName) ||
                !string.IsNullOrWhiteSpace(p.circuitNumber));
            if (!p.dryRun && !p.confirm) throw new InvalidOperationException("existing_power_circuit_move_requires_confirm_true");
            var systemId = p.electricalSystemId.Value;
            var system = doc.GetElement(ElementIdCompat.Create(systemId)) as ElectricalSystem
                ?? throw new InvalidOperationException($"electrical_system_not_found:{systemId}");
            var panel = doc.GetElement(ElementIdCompat.Create(p.panelElementId!.Value)) as FamilyInstance
                ?? throw new InvalidOperationException($"panel_element_not_family_instance:{p.panelElementId}");
            var expectedMembers = expectedMemberIds.OrderBy(id => id).ToList();
            var before = ReadNativePowerCircuit(system);
            VerifyNativePowerCircuitReadback(before, expectedMembers, before.PanelElementId);
            var beforeSchedules = ReadPanelScheduleState(doc, new[] { before.PanelElementId, p.panelElementId });
            var nativeFailures = new List<CapturedFailure>();
            PanelScheduleSlotReadback? slot = null;
            enterNativeScope();
            var result = NativeTransactionGroup.Execute(app, doc, "Move and Verify Existing Electrical Circuit", () =>
            {
                using (var tx = new Transaction(doc, "Move Existing Electrical Circuit"))
                {
                    if (tx.Start() != TransactionStatus.Started) throw new InvalidOperationException("existing_power_circuit_move_transaction_not_started");
                    tx.SetFailureHandlingOptions(FailureHandlingUtil.ConfigureFailureCapture(tx, nativeFailures,
                        rollbackOnErrors: true, deleteWarnings: true));
                    if (ElementIdCompat.GetValue(system.BaseEquipment?.Id) != ElementIdCompat.GetValue(panel.Id))
                    {
                        system.SelectPanel(panel);
                        doc.Regenerate();
                    }
                    slot = MoveCircuitToPanelScheduleSlot(doc, panel, system, p.targetPanelSlotNumber!.Value, p.expectedCircuitNumber);
                    doc.Regenerate();
                    VerifyNativePowerCircuitReadback(ReadNativePowerCircuit(system), expectedMembers, p.panelElementId);
                    var committed = tx.Commit();
                    if (committed != TransactionStatus.Committed) throw new InvalidOperationException($"existing_power_circuit_move_transaction_not_committed:{committed}");
                    if (FailureHandlingUtil.HasErrors(nativeFailures)) throw new InvalidOperationException("existing_power_circuit_move_native_failure");
                }
                return ReadPersistedCircuitResult(doc, systemId, expectedMembers, p, slot);
            }, p.dryRun ? NativeTransactionDisposition.Rollback : NativeTransactionDisposition.Commit);
            CompleteCircuitOutcome(result, p, "operator.assign_electrical_circuit.v5", "move_existing_power_circuit",
                () =>
                {
                    var restored = ReadNativePowerCircuit(doc.GetElement(ElementIdCompat.Create(systemId)) as ElectricalSystem
                        ?? throw new InvalidOperationException($"existing_power_circuit_missing_after_rollback:{systemId}"));
                    VerifyNativePowerCircuitReadback(restored, before.MemberElementIds, before.PanelElementId);
                    if (!string.Equals(restored.CircuitNumber, before.CircuitNumber, StringComparison.OrdinalIgnoreCase) ||
                        !PanelScheduleStatesEqual(beforeSchedules, ReadPanelScheduleState(doc, new[] { before.PanelElementId, p.panelElementId })))
                        throw new InvalidOperationException("existing_power_circuit_move_rollback_verification_failed");
                }, () => ReadPersistedCircuitResult(doc, systemId, expectedMembers, p, slot), nativeFailures);
            result["electricalSystemId"] = systemId;
            result["limitation"] = "Moves one existing native PowerCircuit and verifies actual members, panel and schedule slot. Engineering sizing and code compliance require separate checks.";
            return result;
        }

        private static object CreateNewPowerCircuit(UIApplication app, Document doc, Params p,
            List<long> ids, Action enterNativeScope)
        {
            CircuitMatchPolicy.RequireCircuitCreateRequest(ids, p.panelElementId, p.targetPanelSlotNumber,
                p.electricalConnectorId, p.expectedCircuitNumber, p.sourceElementId.HasValue ||
                p.electricalSystemId.HasValue || p.parameterOnlyFallback || !string.IsNullOrWhiteSpace(p.panelName) ||
                !string.IsNullOrWhiteSpace(p.circuitNumber));
            if (!p.dryRun && !p.confirm) throw new InvalidOperationException("new_power_circuit_requires_confirm_true");
            var members = ids.Select(id => doc.GetElement(ElementIdCompat.Create(id)) as FamilyInstance
                ?? throw new InvalidOperationException($"target_element_not_family_instance:{id}")).ToList();
            var beforeMemberships = members.ToDictionary(member => ElementIdCompat.GetValue(member.Id),
                member => HostedPlacementUtil.GetPowerElectricalSystemIds(member).OrderBy(id => id).ToList());
            if (beforeMemberships.Any(entry => entry.Value.Count != 0))
                throw new InvalidOperationException("new_power_circuit_requires_uncircuitized_members");
            var panel = p.panelElementId.HasValue
                ? doc.GetElement(ElementIdCompat.Create(p.panelElementId.Value)) as FamilyInstance
                    ?? throw new InvalidOperationException($"panel_element_not_family_instance:{p.panelElementId}")
                : null;
            // Resolve connector and mixed-mode errors before any native transaction begins.
            var connector = p.electricalConnectorId.HasValue
                ? ResolveUnusedPowerConnector(members[0], p.electricalConnectorId.Value) : null;
            var beforeSchedules = ReadPanelScheduleState(doc, new[] { p.panelElementId });
            var expectedMembers = ids.OrderBy(id => id).ToList();
            var nativeFailures = new List<CapturedFailure>();
            long? systemId = null;
            PanelScheduleSlotReadback? slot = null;
            enterNativeScope();
            var result = NativeTransactionGroup.Execute(app, doc, "Create and Verify Electrical Circuit", () =>
            {
                using (var tx = new Transaction(doc, "Create Electrical Circuit"))
                {
                    if (tx.Start() != TransactionStatus.Started) throw new InvalidOperationException("new_power_circuit_transaction_not_started");
                    tx.SetFailureHandlingOptions(FailureHandlingUtil.ConfigureFailureCapture(tx, nativeFailures,
                        rollbackOnErrors: true, deleteWarnings: true));
                    var system = connector != null
                        ? ElectricalSystem.Create(connector, ElectricalSystemType.PowerCircuit)
                        : ElectricalSystem.Create(doc, members.Select(member => member.Id).ToList(), ElectricalSystemType.PowerCircuit);
                    if (system == null) throw new InvalidOperationException("revit_did_not_create_electrical_system");
                    systemId = ElementIdCompat.GetValue(system.Id);
                    if (panel != null) system.SelectPanel(panel);
                    doc.Regenerate();
                    if (p.targetPanelSlotNumber.HasValue)
                        slot = MoveCircuitToPanelScheduleSlot(doc, panel!, system, p.targetPanelSlotNumber.Value, p.expectedCircuitNumber);
                    doc.Regenerate();
                    VerifyNativePowerCircuitReadback(ReadNativePowerCircuit(system), expectedMembers, p.panelElementId);
                    var committed = tx.Commit();
                    if (committed != TransactionStatus.Committed) throw new InvalidOperationException($"new_power_circuit_transaction_not_committed:{committed}");
                    if (FailureHandlingUtil.HasErrors(nativeFailures)) throw new InvalidOperationException("new_power_circuit_native_failure");
                }
                return ReadPersistedCircuitResult(doc, systemId!.Value, expectedMembers, p, slot);
            }, p.dryRun ? NativeTransactionDisposition.Rollback : NativeTransactionDisposition.Commit,
                nativeCreatedElements: () => systemId.HasValue ? new[] { systemId.Value } : Array.Empty<long>());
            CompleteCircuitOutcome(result, p, "operator.assign_electrical_circuit.v4", "create_new_power_circuit",
                () =>
                {
                    if (!systemId.HasValue || doc.GetElement(ElementIdCompat.Create(systemId.Value)) != null ||
                        members.Any(member => !beforeMemberships[ElementIdCompat.GetValue(member.Id)].SequenceEqual(
                            HostedPlacementUtil.GetPowerElectricalSystemIds(member).OrderBy(id => id))) ||
                        !PanelScheduleStatesEqual(beforeSchedules, ReadPanelScheduleState(doc, new[] { p.panelElementId })))
                        throw new InvalidOperationException("new_power_circuit_rollback_verification_failed");
                }, () => ReadPersistedCircuitResult(doc, systemId!.Value, expectedMembers, p, slot), nativeFailures);
            var receipt = (OperatorNativeTransactionReceipt)result["transaction"]!;
            // A preview ID describes a transient object, not a retained model element.
            result["createdElectricalSystemId"] = receipt.CommittedValue == true ? systemId : null;
            if (result["previewExecuted"] is true) result["previewElectricalSystemId"] = systemId;
            result["requestedSystemType"] = "PowerCircuit";
            result["electricalConnectorId"] = p.electricalConnectorId;
            result["limitation"] = "Creates and verifies actual native PowerCircuit membership and an explicitly requested panel slot. Engineering sizing and code compliance require separate checks.";
            return result;
        }

        private static Dictionary<string, object?> ReadPersistedCircuitResult(Document doc, long systemId,
            IReadOnlyList<long> expectedMembers, Params p, PanelScheduleSlotReadback? requestedSlot)
        {
            var circuit = ReadNativePowerCircuit(doc.GetElement(ElementIdCompat.Create(systemId)) as ElectricalSystem
                ?? throw new InvalidOperationException($"native_power_circuit_missing_during_readback:{systemId}"));
            VerifyNativePowerCircuitReadback(circuit, expectedMembers, p.panelElementId);
            var memberResults = expectedMembers.Select(id =>
            {
                var member = doc.GetElement(ElementIdCompat.Create(id)) as FamilyInstance
                    ?? throw new InvalidOperationException($"native_power_circuit_member_missing:{id}");
                if (!CircuitMatchPolicy.HasExactMembership(systemId, HostedPlacementUtil.GetPowerElectricalSystemIds(member)))
                    throw new InvalidOperationException($"native_power_circuit_member_system_mismatch:{id}:{systemId}");
                return (object)new { elementId = id, ok = true, after = HostedPlacementUtil.BuildElectricalCircuitAuditPayload(member) };
            }).ToList();
            var freshSlot = p.targetPanelSlotNumber.HasValue
                ? ReadCurrentPanelScheduleSlot(doc, circuit, requestedSlot, p.targetPanelSlotNumber.Value) : null;
            VerifyPanelScheduleSlotReadback(freshSlot, circuit, p.targetPanelSlotNumber, p.expectedCircuitNumber);
            return new Dictionary<string, object?> { ["nativeCircuitReadback"] = NativePowerCircuitReadbackPayload(circuit),
                ["panelScheduleSlot"] = PanelScheduleSlotReadbackPayload(freshSlot),
                ["verifiedMemberElementIds"] = expectedMembers, ["results"] = memberResults };
        }

        private static void CompleteCircuitOutcome(Dictionary<string, object?> result, Params p, string schema,
            string mode, Action verifyRestored, Func<Dictionary<string, object?>> readPersisted,
            List<CapturedFailure> nativeFailures)
        {
            var receipt = (OperatorNativeTransactionReceipt)result["transaction"]!;
            result["schema"] = schema; result["mode"] = mode;
            result["panelElementId"] = p.panelElementId; result["targetPanelSlotNumber"] = p.targetPanelSlotNumber;
            result["expectedCircuitNumber"] = p.expectedCircuitNumber; result["dryRun"] = p.dryRun;
            result["transactionGroupRolledBack"] = receipt.Status == "rolled_back";
            result["rollbackVerified"] = false; result["previewExecuted"] = false;
            result["applied"] = receipt.CommittedValue;
            if (p.dryRun && receipt.Status == "rolled_back" && result["success"] is true)
            {
                try { verifyRestored(); result["rollbackVerified"] = true; result["previewExecuted"] = true; }
                catch (Exception error) { result["success"] = false; result["error"] = error.Message; }
            }
            else if (!p.dryRun) OperatorNativeTransactionExecution.ReadCommitted(result, readPersisted);
            var checkedOutcome = result["success"] is true && (p.dryRun ? result["rollbackVerified"] is true
                : result.TryGetValue("verified", out var verified) && verified is true);
            result["verification"] = new { nativePowerCircuit = checkedOutcome, exactMemberSet = checkedOutcome,
                exactPanelIdentity = checkedOutcome, exactPanelScheduleSlot = checkedOutcome,
                expectedCircuitNumberMatched = checkedOutcome, factualLoadReadback = checkedOutcome,
                rollbackVerified = p.dryRun ? result["rollbackVerified"] : null, complianceEvaluated = false };
            result["nativeFailures"] = nativeFailures;
            result["warnings"] = nativeFailures.Where(f => string.Equals(f.severity, "warning", StringComparison.OrdinalIgnoreCase))
                .Select(f => f.message).Where(message => !string.IsNullOrWhiteSpace(message)).Distinct().ToList();
            result["status"] = OperatorNativeTransactionExecution.OutcomeStatus(result, "Applied", "Planned");
        }

        private static PanelScheduleSlotReadback ReadCurrentPanelScheduleSlot(Document doc, NativePowerCircuitReadback circuit,
            PanelScheduleSlotReadback? requested, int slotNumber)
        {
            var schedule = requested == null ? null
                : doc.GetElement(ElementIdCompat.Create(requested.ScheduleElementId)) as PanelScheduleView;
            if (schedule == null || schedule.IsPanelScheduleTemplate() || !circuit.PanelElementId.HasValue ||
                ElementIdCompat.GetValue(schedule.GetPanel()) != circuit.PanelElementId.Value)
                throw new InvalidOperationException("native_panel_schedule_identity_mismatch");
            IList<int> rows; IList<int> columns;
            schedule.GetCellsBySlotNumber(slotNumber, out rows, out columns);
            if (rows == null || columns == null || rows.Count == 0 || rows.Count != columns.Count)
                throw new InvalidOperationException($"native_panel_schedule_slot_missing:{slotNumber}");
            for (var index = 0; index < rows.Count; index++)
            {
                var id = schedule.GetCircuitIdByCell(rows[index], columns[index]);
                if (id == null || ElementIdCompat.GetValue(id) != circuit.SystemElementId) continue;
                return new PanelScheduleSlotReadback { ScheduleElementId = requested!.ScheduleElementId,
                    ScheduleCreated = requested.ScheduleCreated, TargetSlotNumber = slotNumber,
                    SourceRow = requested.SourceRow, SourceColumn = requested.SourceColumn,
                    TargetRow = rows[index], TargetColumn = columns[index], TargetContainsExactSystem = true,
                    ActualCircuitNumber = circuit.CircuitNumber };
            }
            throw new InvalidOperationException($"native_panel_schedule_slot_system_mismatch:{circuit.SystemElementId}:{slotNumber}");
        }

        private static Dictionary<long, string> ReadPanelScheduleState(Document doc, IEnumerable<long?> panelIds)
        {
            var panels = new HashSet<long>(panelIds.Where(id => id.HasValue).Select(id => id!.Value));
            var state = new Dictionary<long, string>();
            foreach (var schedule in new FilteredElementCollector(doc).OfClass(typeof(PanelScheduleView)).Cast<PanelScheduleView>())
            {
                if (schedule.IsPanelScheduleTemplate() || !panels.Contains(ElementIdCompat.GetValue(schedule.GetPanel()))) continue;
                var cells = new List<string>();
                var body = schedule.GetTableData().GetSectionData(SectionType.Body);
                for (var row = body.FirstRowNumber; row <= body.LastRowNumber; row++)
                    for (var column = body.FirstColumnNumber; column <= body.LastColumnNumber; column++)
                    {
                        // Revit returns InvalidElementId for empty circuit cells. API failures are not hidden.
                        var id = schedule.GetCircuitIdByCell(row, column);
                        cells.Add($"{row}:{column}:{ElementIdCompat.GetValue(id)}");
                    }
                state.Add(ElementIdCompat.GetValue(schedule.Id), string.Join("|", cells));
            }
            return state;
        }

        private static bool PanelScheduleStatesEqual(Dictionary<long, string> before, Dictionary<long, string> after)
            => before.Count == after.Count && before.All(entry => after.TryGetValue(entry.Key, out var value) && value == entry.Value);


        private static Connector ResolveUnusedPowerConnector(FamilyInstance member, long connectorId)
        {
            var matches = MepSystemUtil.GetConnectors(member)
                .Where(connector => MepSystemUtil.TryGetNativeConnectorId(connector, out var nativeId) && nativeId == connectorId)
                .ToList();
            if (matches.Count != 1)
                throw new InvalidOperationException($"electrical_connector_id_not_unique:{connectorId}:found={matches.Count}");

            var connector = matches[0];
            string domain;
            try { domain = connector.Domain.ToString(); }
            catch { domain = string.Empty; }
            if (!string.Equals(domain, "DomainElectrical", StringComparison.OrdinalIgnoreCase))
                throw new InvalidOperationException($"connector_is_not_electrical:{connectorId}:domain={domain}");

            string systemType;
            try { systemType = connector.ElectricalSystemType.ToString(); }
            catch { systemType = string.Empty; }
            if (!string.Equals(systemType, ElectricalSystemType.PowerCircuit.ToString(), StringComparison.OrdinalIgnoreCase))
                throw new InvalidOperationException($"connector_is_not_power_circuit:{connectorId}:systemType={systemType}");

            var existingSystemIds = new HashSet<long>();
            try
            {
                foreach (Connector reference in connector.AllRefs)
                {
                    if (reference?.Owner is ElectricalSystem existing)
                        existingSystemIds.Add(ElementIdCompat.GetValue(existing.Id));
                }
            }
            catch
            {
                // ElectricalSystem.Create remains the final native unused-connector guard.
            }
            if (existingSystemIds.Count > 0)
                throw new InvalidOperationException($"connector_already_has_electrical_system:{connectorId}:{string.Join(",", existingSystemIds.OrderBy(id => id))}");
            return connector;
        }

        private static PanelScheduleSlotReadback MoveCircuitToPanelScheduleSlot(
            Document doc,
            FamilyInstance panel,
            ElectricalSystem system,
            int targetSlotNumber,
            string? expectedCircuitNumber)
        {
            var panelId = ElementIdCompat.GetValue(panel.Id);
            var schedule = new FilteredElementCollector(doc)
                .OfClass(typeof(PanelScheduleView))
                .Cast<PanelScheduleView>()
                .FirstOrDefault(view =>
                {
                    try
                    {
                        return !view.IsPanelScheduleTemplate() && ElementIdCompat.GetValue(view.GetPanel()) == panelId;
                    }
                    catch
                    {
                        return false;
                    }
                });
            var scheduleCreated = false;
            if (schedule == null)
            {
                schedule = PanelScheduleView.CreateInstanceView(doc, panel.Id)
                    ?? throw new InvalidOperationException($"panel_schedule_create_failed:{panelId}");
                scheduleCreated = true;
                doc.Regenerate();
            }

            var sourceCell = FindCircuitCell(schedule, system.Id)
                ?? throw new InvalidOperationException($"panel_schedule_source_cell_not_found:{ElementIdCompat.GetValue(system.Id)}");
            IList<int> targetRows;
            IList<int> targetColumns;
            schedule.GetCellsBySlotNumber(targetSlotNumber, out targetRows, out targetColumns);
            if (targetRows == null || targetColumns == null || targetRows.Count == 0 || targetRows.Count != targetColumns.Count)
                throw new InvalidOperationException($"panel_schedule_target_slot_not_found:{targetSlotNumber}");

            var targetCell = (row: -1, column: -1);
            for (var i = 0; i < targetRows.Count; i++)
            {
                var row = targetRows[i];
                var column = targetColumns[i];
                if (row == sourceCell.row && column == sourceCell.column)
                {
                    targetCell = (row, column);
                    break;
                }
                try
                {
                    if (schedule.CanMoveSlotTo(sourceCell.row, sourceCell.column, row, column))
                    {
                        targetCell = (row, column);
                        break;
                    }
                }
                catch
                {
                    // Continue through every cell representing the requested slot.
                }
            }
            if (targetCell.row < 0)
                throw new InvalidOperationException($"panel_schedule_target_slot_unavailable:{targetSlotNumber}");

            if (targetCell.row != sourceCell.row || targetCell.column != sourceCell.column)
            {
                schedule.MoveSlotTo(sourceCell.row, sourceCell.column, targetCell.row, targetCell.column);
                doc.Regenerate();
            }

            var exactSystemId = ElementIdCompat.GetValue(system.Id);
            var targetContainsExactSystem = false;
            for (var i = 0; i < targetRows.Count; i++)
            {
                try
                {
                    var circuitId = schedule.GetCircuitIdByCell(targetRows[i], targetColumns[i]);
                    if (circuitId != null && ElementIdCompat.GetValue(circuitId) == exactSystemId)
                    {
                        targetContainsExactSystem = true;
                        targetCell = (targetRows[i], targetColumns[i]);
                        break;
                    }
                }
                catch
                {
                    // Verification below fails closed when the exact system is absent.
                }
            }

            var actualCircuitNumber = SafeCircuitString(() => system.CircuitNumber);
            if (!targetContainsExactSystem)
                throw new InvalidOperationException($"panel_schedule_exact_system_not_in_target_slot:{exactSystemId}:{targetSlotNumber}");
            if (!string.IsNullOrWhiteSpace(expectedCircuitNumber) &&
                !string.Equals(actualCircuitNumber, expectedCircuitNumber.Trim(), StringComparison.OrdinalIgnoreCase))
                throw new InvalidOperationException($"panel_schedule_circuit_number_mismatch:expected={expectedCircuitNumber.Trim()}:actual={actualCircuitNumber}");

            return new PanelScheduleSlotReadback
            {
                ScheduleElementId = ElementIdCompat.GetValue(schedule.Id),
                ScheduleCreated = scheduleCreated,
                TargetSlotNumber = targetSlotNumber,
                SourceRow = sourceCell.row,
                SourceColumn = sourceCell.column,
                TargetRow = targetCell.row,
                TargetColumn = targetCell.column,
                TargetContainsExactSystem = targetContainsExactSystem,
                ActualCircuitNumber = actualCircuitNumber
            };
        }

        private static (int row, int column)? FindCircuitCell(PanelScheduleView schedule, ElementId systemId)
        {
            var expectedId = ElementIdCompat.GetValue(systemId);
            var body = schedule.GetTableData().GetSectionData(SectionType.Body);
            for (var row = body.FirstRowNumber; row <= body.LastRowNumber; row++)
            {
                for (var column = body.FirstColumnNumber; column <= body.LastColumnNumber; column++)
                {
                    try
                    {
                        var circuitId = schedule.GetCircuitIdByCell(row, column);
                        if (circuitId != null && ElementIdCompat.GetValue(circuitId) == expectedId)
                            return (row, column);
                    }
                    catch
                    {
                        // Header/load-summary cells are not circuit cells.
                    }
                }
            }
            return null;
        }

        private static void VerifyPanelScheduleSlotReadback(
            PanelScheduleSlotReadback? slot,
            NativePowerCircuitReadback circuit,
            int? expectedSlot,
            string? expectedCircuitNumber)
        {
            if (!expectedSlot.HasValue) return;
            if (slot == null || slot.TargetSlotNumber != expectedSlot.Value || !slot.TargetContainsExactSystem)
                throw new InvalidOperationException($"panel_schedule_slot_verification_failed:{expectedSlot.Value}");
            if (!string.IsNullOrWhiteSpace(expectedCircuitNumber) &&
                !string.Equals(circuit.CircuitNumber, expectedCircuitNumber.Trim(), StringComparison.OrdinalIgnoreCase))
                throw new InvalidOperationException($"panel_schedule_circuit_number_verification_failed:expected={expectedCircuitNumber.Trim()}:actual={circuit.CircuitNumber}");
        }

        private static object? PanelScheduleSlotReadbackPayload(PanelScheduleSlotReadback? slot)
        {
            if (slot == null) return null;
            return new
            {
                scheduleElementId = slot.ScheduleElementId,
                scheduleCreated = slot.ScheduleCreated,
                targetSlotNumber = slot.TargetSlotNumber,
                sourceCell = new { row = slot.SourceRow, column = slot.SourceColumn },
                targetCell = new { row = slot.TargetRow, column = slot.TargetColumn },
                targetContainsExactSystem = slot.TargetContainsExactSystem,
                actualCircuitNumber = string.IsNullOrWhiteSpace(slot.ActualCircuitNumber) ? null : slot.ActualCircuitNumber
            };
        }

        private static NativePowerCircuitReadback ReadNativePowerCircuit(ElectricalSystem system)
        {
            var memberElementIds = new List<long>();
            foreach (Element member in system.Elements)
            {
                if (member?.Id != null) memberElementIds.Add(ElementIdCompat.GetValue(member.Id));
            }

            return new NativePowerCircuitReadback
            {
                SystemElementId = ElementIdCompat.GetValue(system.Id),
                SystemType = system.SystemType.ToString(),
                MemberElementIds = memberElementIds.Distinct().OrderBy(id => id).ToList(),
                PanelElementId = system.BaseEquipment == null ? (long?)null : ElementIdCompat.GetValue(system.BaseEquipment.Id),
                PanelName = SafeCircuitString(() => system.PanelName),
                CircuitNumber = SafeCircuitString(() => system.CircuitNumber),
                TrueLoadInternal = SafeCircuitDouble(() => system.TrueLoad),
                ApparentLoadInternal = SafeCircuitDouble(() => system.ApparentLoad),
                VoltageInternal = SafeCircuitDouble(() => system.Voltage),
                Poles = SafeCircuitInt(() => system.PolesNumber)
            };
        }

        private static void VerifyNativePowerCircuitReadback(
            NativePowerCircuitReadback readback,
            IReadOnlyList<long> expectedMemberElementIds,
            long? expectedPanelElementId)
        {
            if (readback.SystemElementId <= 0 || !CircuitMatchPolicy.IsExactPowerCircuitType(readback.SystemType))
                throw new InvalidOperationException($"new_power_circuit_type_verification_failed:{readback.SystemElementId}:{readback.SystemType}");
            if (!CircuitMatchPolicy.HasExactElementSet(expectedMemberElementIds, readback.MemberElementIds))
                throw new InvalidOperationException(
                    $"new_power_circuit_exact_member_set_failed:{readback.SystemElementId}:expected={string.Join(",", expectedMemberElementIds)}:actual={string.Join(",", readback.MemberElementIds)}");
            if (!CircuitMatchPolicy.HasExactOptionalElementIdentity(expectedPanelElementId, readback.PanelElementId))
                throw new InvalidOperationException(
                    $"new_power_circuit_exact_panel_failed:{readback.SystemElementId}:expected={expectedPanelElementId?.ToString(CultureInfo.InvariantCulture) ?? "unassigned"}:actual={readback.PanelElementId?.ToString(CultureInfo.InvariantCulture) ?? "unassigned"}");
            if (!CircuitMatchPolicy.HasFactualLoadReadback(readback.TrueLoadInternal, readback.ApparentLoadInternal))
                throw new InvalidOperationException($"new_power_circuit_factual_load_readback_unavailable:{readback.SystemElementId}");
        }

        private static object NativePowerCircuitReadbackPayload(NativePowerCircuitReadback readback)
        {
            return new
            {
                systemElementId = readback.SystemElementId,
                systemType = readback.SystemType,
                memberElementIds = readback.MemberElementIds,
                panelElementId = readback.PanelElementId,
                panelName = string.IsNullOrWhiteSpace(readback.PanelName) ? null : readback.PanelName,
                circuitNumber = string.IsNullOrWhiteSpace(readback.CircuitNumber) ? null : readback.CircuitNumber,
                trueLoadInternal = readback.TrueLoadInternal,
                apparentLoadInternal = readback.ApparentLoadInternal,
                voltageInternal = readback.VoltageInternal,
                poles = readback.Poles,
                limitation = "Native Revit factual readback only. Values do not by themselves prove breaker sizing, conductor ampacity, panel capacity, continuous-load treatment, or code compliance."
            };
        }

        private static string SafeCircuitString(Func<string> read)
        {
            try { return (read() ?? string.Empty).Trim(); }
            catch { return string.Empty; }
        }

        private static double? SafeCircuitDouble(Func<double> read)
        {
            try
            {
                var value = read();
                return double.IsNaN(value) || double.IsInfinity(value) ? (double?)null : value;
            }
            catch
            {
                return null;
            }
        }

        private static int? SafeCircuitInt(Func<int> read)
        {
            try { return read(); }
            catch { return null; }
        }

        private static bool TrySetStringParameter(Element element, string name, string? value, bool apply, out string detail)
        {
            detail = "";
            if (string.IsNullOrWhiteSpace(value))
            {
                detail = $"{name}: no requested value";
                return false;
            }

            var p = element.LookupParameter(name);
            if (p == null)
            {
                detail = $"{name}: parameter not found";
                return false;
            }
            if (p.IsReadOnly)
            {
                detail = $"{name}: read-only";
                return false;
            }
            if (p.StorageType != StorageType.String)
            {
                detail = $"{name}: storage type {p.StorageType} is not string";
                return false;
            }
            if (apply) p.Set(value.Trim());
            detail = $"{name}: writable";
            return true;
        }

        private static string ReadAnonymousString(object? payload, string propertyName)
        {
            if (payload == null) return "";
            try
            {
                return payload.GetType().GetProperty(propertyName)?.GetValue(payload)?.ToString() ?? "";
            }
            catch
            {
                return "";
            }
        }
    }
}
