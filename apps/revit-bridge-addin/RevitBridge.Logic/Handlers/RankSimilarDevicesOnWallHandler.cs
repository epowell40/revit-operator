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
        public sealed class Params
        {
            public long[]? elementIds { get; set; }
            public string? panelName { get; set; }
            public string? circuitNumber { get; set; }
            public long? sourceElementId { get; set; }
            public string? createSystemType { get; set; }
            public long? panelElementId { get; set; }
            public bool dryRun { get; set; } = true;
            public bool confirm { get; set; } = false;
            public bool parameterOnlyFallback { get; set; } = false;
        }

        public Task<object> Handle(UIApplication app, string jsonData)
        {
            var p = string.IsNullOrWhiteSpace(jsonData)
                ? new Params()
                : JsonSerializer.Deserialize<Params>(jsonData, RankSimilarDevicesOnWallHandler.JsonOptions) ?? new Params();
            var doc = app.ActiveUIDocument?.Document ?? throw new InvalidOperationException("No active Revit document.");
            var ids = (p.elementIds ?? Array.Empty<long>()).Distinct().ToList();
            if (ids.Count == 0) throw new InvalidOperationException("assign-electrical-circuit requires elementIds.");

            var source = p.sourceElementId.HasValue && p.sourceElementId.Value > 0
                ? doc.GetElement(ElementIdCompat.Create(p.sourceElementId.Value))
                : null;
            var createNewPowerCircuit = string.Equals(p.createSystemType, "PowerCircuit", StringComparison.OrdinalIgnoreCase);
            if (createNewPowerCircuit)
            {
                if (source != null) throw new InvalidOperationException("create_new_power_circuit_cannot_use_source_element");
                return Task.FromResult(CreateNewPowerCircuit(doc, p, ids));
            }
            if (!string.IsNullOrWhiteSpace(p.createSystemType))
                throw new InvalidOperationException("createSystemType must be PowerCircuit when supplied.");
            var results = new List<object>();
            var warnings = new List<string>();
            var apply = !p.dryRun && p.confirm;

            Transaction? tx = null;
            if (apply)
            {
                tx = new Transaction(doc, "Assign Electrical Circuit");
                tx.Start();
            }

            try
            {
                foreach (var id in ids)
                {
                    var element = doc.GetElement(ElementIdCompat.Create(id));
                    var fi = element as FamilyInstance;
                    if (element == null)
                    {
                        results.Add(new { elementId = id, ok = false, reason = "Element not found." });
                        continue;
                    }

                    var before = HostedPlacementUtil.BuildElectricalCircuitAuditPayload(fi);
                    var action = "none";
                    var ok = false;
                    var detail = "";
                    if (!apply && source != null && fi != null)
                    {
                        var sourcePowerSystemIds = HostedPlacementUtil.GetPowerElectricalSystemIds(source as FamilyInstance);
                        var sourceAudit = HostedPlacementUtil.BuildElectricalCircuitAuditPayload(source as FamilyInstance);
                        var sourceLabel = ReadAnonymousString(sourceAudit, "primaryLabel");
                        action = "preflight_match_source_electrical_system";
                        ok = sourcePowerSystemIds.Count == 1;
                        detail = ok
                            ? $"Source exemplar has exactly one power system ({sourcePowerSystemIds[0]}; {sourceLabel}). Apply with dryRun:false and confirm:true to join it."
                            : $"Source exemplar must have exactly one power system; found {sourcePowerSystemIds.Count}.";
                    }
                    else if (apply && source != null && fi != null)
                    {
                        var sourcePowerSystemIds = HostedPlacementUtil.GetPowerElectricalSystemIds(source as FamilyInstance);
                        if (sourcePowerSystemIds.Count != 1)
                            throw new InvalidOperationException($"source_element_requires_one_power_system:{p.sourceElementId}:found={sourcePowerSystemIds.Count}");
                        ok = HostedPlacementUtil.TryReassignElectricalCircuitFromSource(source, fi, true, warnings, out detail);
                        action = "match_source_electrical_system";
                        var finalPowerSystemIds = HostedPlacementUtil.GetPowerElectricalSystemIds(fi);
                        if (!ok || !CircuitMatchPolicy.HasExactMembership(sourcePowerSystemIds[0], finalPowerSystemIds))
                            throw new InvalidOperationException("exact_source_power_system_assignment_failed:" + id + ":" + detail);
                    }

                    if (source == null && (!apply || !ok) && p.parameterOnlyFallback)
                    {
                        var setPanel = TrySetStringParameter(element, "Panel", p.panelName, apply, out var panelDetail);
                        var setCircuit = TrySetStringParameter(element, "Circuit Number", p.circuitNumber, apply, out var circuitDetail);
                        action = apply ? "parameter_write_fallback" : "preflight_parameter_write";
                        ok = (!string.IsNullOrWhiteSpace(p.panelName) || !string.IsNullOrWhiteSpace(p.circuitNumber))
                            && (setPanel || setCircuit);
                        detail = string.Join("; ", new[] { panelDetail, circuitDetail }.Where(x => !string.IsNullOrWhiteSpace(x)));
                    }

                    var after = HostedPlacementUtil.BuildElectricalCircuitAuditPayload(fi);
                    results.Add(new
                    {
                        elementId = id,
                        ok,
                        action,
                        detail,
                        before,
                        after,
                        requested = new { panel = p.panelName, circuitNumber = p.circuitNumber, sourceElementId = p.sourceElementId },
                        dryRun = !apply
                    });
                }

                if (tx != null) tx.Commit();
            }
            catch
            {
                if (tx != null && tx.GetStatus() == TransactionStatus.Started) tx.RollBack();
                throw;
            }

            return Task.FromResult<object>(new
            {
                schema = "operator.assign_electrical_circuit.v2",
                applied = apply,
                mode = source != null ? "strict_exact_source_power_system" : p.parameterOnlyFallback ? "explicit_parameter_only_fallback" : "no_assignment_mode_selected",
                limitation = "sourceElementId uses atomic real ElectricalSystem reassignment with exact source-system-ID readback. Direct panel/circuit values are labels only and are attempted solely when parameterOnlyFallback:true is explicitly requested; they do not prove circuit membership or electrical compliance.",
                results,
                warnings
            });
        }

        private static object CreateNewPowerCircuit(Document doc, Params p, List<long> ids)
        {
            var apply = !p.dryRun && p.confirm;
            var members = new List<FamilyInstance>();
            var preflightResults = new List<object>();
            foreach (var id in ids)
            {
                var instance = doc.GetElement(ElementIdCompat.Create(id)) as FamilyInstance;
                var existingPowerSystemIds = HostedPlacementUtil.GetPowerElectricalSystemIds(instance);
                var ok = instance != null && existingPowerSystemIds.Count == 0;
                preflightResults.Add(new
                {
                    elementId = id,
                    ok,
                    action = apply ? "create_new_power_circuit" : "preflight_create_new_power_circuit",
                    detail = instance == null
                        ? "Element is not a family instance."
                        : existingPowerSystemIds.Count > 0
                            ? $"Member already belongs to power system(s): {string.Join(",", existingPowerSystemIds)}."
                            : "Member is available for a new native PowerCircuit.",
                    before = HostedPlacementUtil.BuildElectricalCircuitAuditPayload(instance),
                    dryRun = !apply
                });
                if (instance != null) members.Add(instance);
            }

            if (preflightResults.Any(result => !(bool)(result.GetType().GetProperty("ok")?.GetValue(result) ?? false)))
            {
                return new
                {
                    schema = "operator.assign_electrical_circuit.v3",
                    status = "Blocked",
                    applied = false,
                    mode = "create_new_power_circuit",
                    createdElectricalSystemId = (long?)null,
                    panelElementId = p.panelElementId,
                    results = preflightResults,
                    warnings = new List<string>(),
                    limitation = "New-circuit mode creates a real native PowerCircuit only from uncircuitized family instances; it does not infer membership, breaker size, load allocation, or panel capacity."
                };
            }

            FamilyInstance? panel = null;
            if (p.panelElementId.HasValue)
            {
                panel = doc.GetElement(ElementIdCompat.Create(p.panelElementId.Value)) as FamilyInstance;
                if (panel == null) throw new InvalidOperationException($"panel_element_not_family_instance:{p.panelElementId.Value}");
            }

            if (!apply)
            {
                return new
                {
                    schema = "operator.assign_electrical_circuit.v3",
                    status = "Ready",
                    applied = false,
                    mode = "create_new_power_circuit",
                    requestedSystemType = "PowerCircuit",
                    createdElectricalSystemId = (long?)null,
                    panelElementId = p.panelElementId,
                    results = preflightResults,
                    warnings = new List<string>(),
                    limitation = "New-circuit mode creates a real native PowerCircuit only from uncircuitized family instances; it does not infer membership, breaker size, load allocation, or panel capacity."
                };
            }

            using (var tx = new Transaction(doc, "Create Electrical Circuit"))
            {
                var nativeFailures = new List<CapturedFailure>();
                tx.Start();
                tx.SetFailureHandlingOptions(FailureHandlingUtil.ConfigureFailureCapture(
                    tx,
                    nativeFailures,
                    rollbackOnErrors: true,
                    deleteWarnings: true));
                try
                {
                    var memberIds = members.Select(instance => instance.Id).ToList();
                    var system = ElectricalSystem.Create(doc, memberIds, ElectricalSystemType.PowerCircuit)
                        ?? throw new InvalidOperationException("revit_did_not_create_electrical_system");
                    if (panel != null) system.SelectPanel(panel);
                    doc.Regenerate();

                    var systemId = ElementIdCompat.GetValue(system.Id);
                    var verifiedResults = members.Select(instance =>
                    {
                        var powerSystemIds = HostedPlacementUtil.GetPowerElectricalSystemIds(instance);
                        var ok = CircuitMatchPolicy.HasExactMembership(systemId, powerSystemIds);
                        return (object)new
                        {
                            elementId = ElementIdCompat.GetValue(instance.Id),
                            ok,
                            action = "create_new_power_circuit",
                            detail = ok
                                ? $"Member joined newly created native power system {systemId}."
                                : $"Expected only new power system {systemId}; actual power systems: {string.Join(",", powerSystemIds)}.",
                            before = (object?)null,
                            after = HostedPlacementUtil.BuildElectricalCircuitAuditPayload(instance),
                            dryRun = false
                        };
                    }).ToList();
                    if (verifiedResults.Any(result => !(bool)(result.GetType().GetProperty("ok")?.GetValue(result) ?? false)))
                        throw new InvalidOperationException($"new_power_circuit_membership_verification_failed:{systemId}");

                    var commitStatus = tx.Commit();
                    if (commitStatus != TransactionStatus.Committed)
                        throw new InvalidOperationException($"new_power_circuit_transaction_not_committed:{commitStatus}");
                    if (FailureHandlingUtil.HasErrors(nativeFailures))
                        throw new InvalidOperationException("new_power_circuit_native_failure");

                    return new
                    {
                        schema = "operator.assign_electrical_circuit.v3",
                        status = "Applied",
                        applied = true,
                        mode = "create_new_power_circuit",
                        requestedSystemType = "PowerCircuit",
                        createdElectricalSystemId = systemId,
                        panelElementId = p.panelElementId,
                        verifiedMemberElementIds = members.Select(instance => ElementIdCompat.GetValue(instance.Id)).OrderBy(id => id).ToList(),
                        results = verifiedResults,
                        warnings = nativeFailures
                            .Where(failure => string.Equals(failure.severity, "warning", StringComparison.OrdinalIgnoreCase))
                            .Select(failure => failure.message)
                            .Where(message => !string.IsNullOrWhiteSpace(message))
                            .Distinct()
                            .ToList(),
                        nativeFailures,
                        limitation = "New-circuit mode creates and verifies native PowerCircuit membership; breaker size, load allocation, panel capacity, and code compliance require separate evidence and checks."
                    };
                }
                catch
                {
                    if (tx.GetStatus() == TransactionStatus.Started) tx.RollBack();
                    throw;
                }
            }
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
