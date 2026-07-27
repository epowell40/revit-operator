using System;
using System.Collections;
using System.Collections.Generic;
using System.Linq;
using System.Reflection;
using Autodesk.Revit.DB;
using Autodesk.Revit.DB.Architecture;
using Autodesk.Revit.DB.Mechanical;
using RevitBridge.Common;

namespace RevitBridge.Logic.Handlers.Core
{
    internal sealed class SpatialCandidatePayload
    {
        public string? spatialKind { get; set; }
        public string? number { get; set; }
        public string? name { get; set; }
        public string? levelName { get; set; }
        public long spatialId { get; set; }
        public string? sourceScopedId { get; set; }
        public string? sourceScope { get; set; }
        public long? linkInstanceId { get; set; }
        public string? linkInstanceName { get; set; }
        public string? sourceDocumentTitle { get; set; }
        public long? phaseId { get; set; }
        public string? phaseName { get; set; }
        public string? method { get; set; }
        public double? boundaryDistanceFt { get; set; }
        public double? levelDeltaFt { get; set; }
        public List<string> equivalentSourceIds { get; set; } = new List<string>();
        public List<string> equivalentPhaseNames { get; set; } = new List<string>();
    }

    internal sealed class ElementSpatialResolutionResult
    {
        public string status { get; set; } = "unresolved";
        public string spatialKindPreference { get; set; } = "auto";
        public SpatialCandidatePayload? selected { get; set; }
        public List<SpatialCandidatePayload> matches { get; set; } = new List<SpatialCandidatePayload>();
        public List<SpatialCandidatePayload> nearestCandidates { get; set; } = new List<SpatialCandidatePayload>();
        public object? representativePoint { get; set; }
        public string? elementLevelName { get; set; }
        public double? elementLevelElevationFt { get; set; }
        public string? unresolvedReason { get; set; }
        public string method { get; set; } = "none";
    }

    internal sealed class ElementSpatialContextResolver
    {
        private sealed class SpatialCandidate
        {
            public SpatialElement? Element { get; set; }
            public string SpatialKind { get; set; } = "SpatialElement";
            public string SourceScope { get; set; } = "host";
            public long? LinkInstanceId { get; set; }
            public string? LinkInstanceName { get; set; }
            public string? SourceDocumentTitle { get; set; }
            public long SpatialId { get; set; }
            public string? SourceScopedId { get; set; }
            public string? Number { get; set; }
            public string? Name { get; set; }
            public string? LevelName { get; set; }
            public double? LevelElevationFt { get; set; }
            public long? PhaseId { get; set; }
            public string? PhaseName { get; set; }
            public List<long> ApplicableHostPhaseIds { get; set; } = new List<long>();
            public string Method { get; set; } = "point_in_boundary";
            public List<IReadOnlyList<SpatialPoint2>> BoundaryLoops { get; set; } = new List<IReadOnlyList<SpatialPoint2>>();
            public Transform SourceToHost { get; set; } = Transform.Identity;
            public Transform HostToSource { get; set; } = Transform.Identity;
            public double? BaseElevationFt { get; set; }
            public double? TopElevationFt { get; set; }
            public double? BoundaryDistanceFt { get; set; }
            public double? LevelDeltaFt { get; set; }

            public string IdentityKey => SpatialCandidateIdentityUtil.Build(
                SpatialKind,
                SourceScope,
                LinkInstanceId,
                SpatialId,
                SourceScopedId ?? "");
        }

        private sealed class CollapsedCandidate
        {
            public SpatialCandidate Primary { get; set; } = null!;
            public List<string> EquivalentSourceIds { get; set; } = new List<string>();
            public List<string> EquivalentPhaseNames { get; set; } = new List<string>();
        }

        private readonly Document _doc;
        private readonly Phase? _hostPhase;
        private readonly bool _phaseAgnostic;
        private readonly string _preference;
        private readonly bool _includeHostRooms;
        private readonly bool _includeHostSpaces;
        private readonly bool _includeLinkedRooms;
        private readonly string? _linkedModelNameContains;
        private readonly int _nearestLimit;
        private const double BoundaryToleranceFt = 1e-5;
        private readonly List<SpatialCandidate> _geometryCandidates;
        private readonly List<string> _warnings;

        public ElementSpatialContextResolver(
            Document doc,
            Phase? hostPhase,
            bool allowPhaseAgnostic,
            string? spatialKindPreference,
            bool includeHostRooms,
            bool includeHostSpaces,
            bool includeLinkedRooms,
            string? linkedModelNameContains,
            int? nearestCandidateLimit)
        {
            _doc = doc;
            _hostPhase = hostPhase;
            _phaseAgnostic = hostPhase == null && allowPhaseAgnostic;
            _preference = NormalizePreference(spatialKindPreference);
            _includeHostRooms = includeHostRooms;
            _includeHostSpaces = includeHostSpaces;
            _includeLinkedRooms = includeLinkedRooms;
            _linkedModelNameContains = linkedModelNameContains;
            _nearestLimit = Math.Max(0, Math.Min(20, nearestCandidateLimit ?? 3));
            _warnings = new List<string>();
            _geometryCandidates = _hostPhase != null || _phaseAgnostic
                ? BuildGeometryCandidates()
                : new List<SpatialCandidate>();
            if (_phaseAgnostic)
                _warnings.Add("No explicit or active-view phase was available. Evaluated factual Room/Space variants across phases; a result resolves only when containing variants agree on one numbered spatial identity.");
            else if (_hostPhase == null)
                _warnings.Add("No effective host phase was resolved; geometric spatial assignments were left unresolved.");
        }

        public IReadOnlyList<string> Warnings => _warnings;

        public ElementSpatialResolutionResult Resolve(Element element)
        {
            var elementLevelName = SpatialIntentUtils.GetLevelName(_doc, element);
            var elementLevelElevation = ResolveElementLevelElevation(_doc, element);
            var lifecyclePresenceByHostPhase = BuildElementLifecyclePresence(element);
            if (_hostPhase != null)
            {
                string? phaseStatus;
                try { phaseStatus = element.GetPhaseStatus(_hostPhase.Id).ToString(); }
                catch { phaseStatus = null; }
                if (!SpatialElementLifecycleUtil.IsPresentInEffectivePhase(phaseStatus ?? ""))
                {
                    return new ElementSpatialResolutionResult
                    {
                        status = "unresolved",
                        spatialKindPreference = _preference,
                        selected = null,
                        matches = new List<SpatialCandidatePayload>(),
                        nearestCandidates = new List<SpatialCandidatePayload>(),
                        representativePoint = null,
                        elementLevelName = elementLevelName,
                        elementLevelElevationFt = elementLevelElevation,
                        unresolvedReason = string.IsNullOrWhiteSpace(phaseStatus)
                            ? "element_phase_status_unavailable"
                            : "element_not_present_in_effective_phase",
                        method = "none"
                    };
                }
            }
            var association = BuildAssociationCandidates(element)
                .Where(candidate => AcceptsCandidate(candidate) && CandidateAppliesToElementLifecycle(candidate, lifecyclePresenceByHostPhase))
                .ToList();

            if (!TryGetRepresentativePoint(element, out var point))
            {
                var associationOnly = Collapse(ChoosePreferredCandidates(
                    association,
                    new List<SpatialCandidate>()));
                var associationStatus = SpatialResolutionDecisionUtil.WithoutGeometryStatus(associationOnly.Count);
                return new ElementSpatialResolutionResult
                {
                    status = associationStatus,
                    spatialKindPreference = _preference,
                    selected = associationStatus == "resolved" ? ToPayload(associationOnly[0]) : null,
                    matches = associationOnly.Select(ToPayload).ToList(),
                    nearestCandidates = new List<SpatialCandidatePayload>(),
                    representativePoint = null,
                    elementLevelName = elementLevelName,
                    elementLevelElevationFt = elementLevelElevation,
                    unresolvedReason = associationStatus == "unresolved"
                        ? "representative_point_unavailable"
                        : null,
                    method = associationOnly.Count > 0 ? "association" : "none"
                };
            }

            var containing = new List<SpatialCandidate>();
            var boundary = new List<SpatialCandidate>();
            var nearest = new List<SpatialCandidate>();
            foreach (var candidate in _geometryCandidates)
            {
                if (!AcceptsCandidate(candidate)) continue;
                if (!CandidateAppliesToElementLifecycle(candidate, lifecyclePresenceByHostPhase)) continue;
                if (!VerticalRangeMatches(point.Z, candidate)) continue;

                candidate.LevelDeltaFt = Delta(elementLevelElevation, candidate.LevelElevationFt);
                candidate.BoundaryDistanceFt = SpatialPolygonUtil.DistanceToBoundary(
                    point.X,
                    point.Y,
                    candidate.BoundaryLoops);
                var relation = SpatialPolygonUtil.Classify(
                    point.X,
                    point.Y,
                    candidate.BoundaryLoops,
                    BoundaryToleranceFt);
                if (relation == SpatialPointRelation.Boundary)
                {
                    var boundaryCandidate = Clone(candidate);
                    boundaryCandidate.Method = "boundary";
                    boundary.Add(boundaryCandidate);
                }
                else if (relation == SpatialPointRelation.Inside && IsPointInsideSpatialVolume(candidate, point))
                {
                    containing.Add(Clone(candidate));
                }
                else
                {
                    nearest.Add(Clone(candidate));
                }
            }

            var considered = ChoosePreferredCandidates(association, containing);
            var boundaryOnly = false;
            if (considered.Count == 0)
            {
                considered = ChoosePreferredCandidates(new List<SpatialCandidate>(), boundary);
                boundaryOnly = considered.Count > 0;
            }
            var collapsed = Collapse(considered);
            var status = !boundaryOnly && collapsed.Count == 1
                ? "resolved"
                : collapsed.Count > 1
                    ? "ambiguous"
                    : boundaryOnly
                        ? "ambiguous"
                    : "unresolved";
            var selected = collapsed.Count == 1 ? ToPayload(collapsed[0]) : null;
            if (status != "resolved") selected = null;
            var nearestPayload = status == "unresolved"
                ? Collapse(ChooseNearestPreference(nearest))
                    .OrderBy(x => x.Primary.BoundaryDistanceFt ?? double.PositiveInfinity)
                    .ThenBy(x => x.Primary.Number)
                    .Take(_nearestLimit)
                    .Select(ToPayload)
                    .ToList()
                : new List<SpatialCandidatePayload>();

            return new ElementSpatialResolutionResult
            {
                status = status,
                spatialKindPreference = _preference,
                selected = selected,
                matches = collapsed.Select(ToPayload).ToList(),
                nearestCandidates = nearestPayload,
                representativePoint = new { x = point.X, y = point.Y, z = point.Z },
                elementLevelName = elementLevelName,
                elementLevelElevationFt = elementLevelElevation,
                unresolvedReason = status == "unresolved" ? "no_containing_spatial_element" : null,
                method = association.Count > 0 && considered.Any(x => x.Method == "association")
                    ? "association"
                    : boundaryOnly
                        ? "boundary"
                        : containing.Count > 0
                        ? "point_in_boundary"
                        : "none"
            };
        }

        public bool MatchesRequestedSpatial(
            ElementSpatialResolutionResult context,
            string? number,
            string? nameContains)
        {
            if (string.IsNullOrWhiteSpace(number) && string.IsNullOrWhiteSpace(nameContains))
                return true;

            return context.matches.Any(candidate =>
                SpatialCandidateFilterUtil.MatchesRequested(
                    candidate.number ?? "",
                    candidate.name ?? "",
                    number ?? "",
                    nameContains ?? ""));
        }

        private List<SpatialCandidate> BuildGeometryCandidates()
        {
            var result = new List<SpatialCandidate>();
            var skippedHostPhase = 0;
            if (_includeHostRooms)
            {
                foreach (var room in new FilteredElementCollector(_doc)
                    .OfCategory(BuiltInCategory.OST_Rooms)
                    .WhereElementIsNotElementType()
                    .Cast<Room>())
                {
                    if (!_phaseAgnostic && !SpatialPhaseMatches(room, _hostPhase))
                    {
                        skippedHostPhase++;
                        continue;
                    }
                    AddHostSpatialCandidate(result, room, "Room");
                }
            }

            if (_includeHostSpaces)
            {
                foreach (var space in new FilteredElementCollector(_doc)
                    .OfCategory(BuiltInCategory.OST_MEPSpaces)
                    .WhereElementIsNotElementType()
                    .Cast<Space>())
                {
                    if (!_phaseAgnostic && !SpatialPhaseMatches(space, _hostPhase))
                    {
                        skippedHostPhase++;
                        continue;
                    }
                    AddHostSpatialCandidate(result, space, "Space");
                }
            }

            if (_includeLinkedRooms) AddLinkedRoomCandidates(result);
            if (!_phaseAgnostic && skippedHostPhase > 0)
                _warnings.Add($"Skipped {skippedHostPhase} host Room/Space records outside effective phase '{_hostPhase?.Name}'.");
            if (result.Count == 0)
                _warnings.Add("No eligible Room or Space boundaries were available for geometric spatial resolution.");
            return result;
        }

        private void AddHostSpatialCandidate(
            List<SpatialCandidate> result,
            SpatialElement spatial,
            string kind)
        {
            var loops = GetBoundaryLoops(spatial, Transform.Identity);
            if (loops.Count == 0) return;
            if (!TryGetSpatialVerticalRange(spatial, Transform.Identity, out var baseZ, out var topZ))
            {
                _warnings.Add($"Skipped {kind} {ElementIdCompat.GetValue(spatial.Id)} because its vertical extent was unavailable.");
                return;
            }
            var phaseId = GetSpatialPhaseId(spatial);
            result.Add(new SpatialCandidate
            {
                Element = spatial,
                SpatialKind = kind,
                SourceScope = "host",
                SourceDocumentTitle = _doc.Title,
                SpatialId = ElementIdCompat.GetValue(spatial.Id),
                SourceScopedId = $"host:{ElementIdCompat.GetValue(spatial.Id)}",
                Number = GetNumber(spatial),
                Name = GetName(spatial),
                LevelName = GetLevelName(_doc, spatial),
                LevelElevationFt = GetLevelElevation(_doc, spatial.LevelId, Transform.Identity),
                PhaseId = phaseId,
                PhaseName = GetSpatialPhaseName(_doc, spatial) ?? _hostPhase?.Name,
                ApplicableHostPhaseIds = phaseId.HasValue && phaseId.Value > 0
                    ? new List<long> { phaseId.Value }
                    : new List<long>(),
                SourceToHost = Transform.Identity,
                HostToSource = Transform.Identity,
                BaseElevationFt = baseZ,
                TopElevationFt = topZ,
                BoundaryLoops = loops
            });
        }

        private void AddLinkedRoomCandidates(List<SpatialCandidate> result)
        {
            foreach (var link in new FilteredElementCollector(_doc)
                .OfClass(typeof(RevitLinkInstance))
                .Cast<RevitLinkInstance>())
            {
                Document? linkDoc = null;
                try { linkDoc = link.GetLinkDocument(); } catch { }
                var linkName = link.Name ?? "";
                var linkId = ElementIdCompat.GetValue(link.Id);
                if (linkDoc == null)
                {
                    _warnings.Add($"Skipped unloaded or unavailable Revit link '{linkName}' ({linkId}); no linked Room assignment was inferred.");
                    continue;
                }

                var linkTitle = linkDoc.Title ?? "";
                if (!MatchesContains(linkName, _linkedModelNameContains) &&
                    !MatchesContains(linkTitle, _linkedModelNameContains))
                    continue;

                if (!TryGetLinkTransform(link, out var transform, out var inverse))
                {
                    _warnings.Add($"Skipped Revit link '{linkName}' ({linkId}) because its coordinate transform was unavailable.");
                    continue;
                }

                var linkedPhase = _phaseAgnostic ? null : TryResolveLinkedPhase(link, linkDoc, _hostPhase);
                if (!_phaseAgnostic && linkedPhase == null)
                {
                    _warnings.Add($"Skipped Revit link '{linkName}' ({linkId}) because phase '{_hostPhase?.Name}' had no reliable linked phase mapping.");
                    continue;
                }
                var hostPhaseIdsByLinkedPhase = _phaseAgnostic
                    ? BuildHostPhaseIdsByLinkedPhase(link)
                    : new Dictionary<long, List<long>>();
                if (_phaseAgnostic && hostPhaseIdsByLinkedPhase.Count == 0)
                {
                    _warnings.Add($"Skipped Revit link '{linkName}' ({linkId}) because its Room phases had no reliable host phase mapping for lifecycle checks.");
                    continue;
                }

                var skippedLinkedPhase = 0;
                foreach (var room in new FilteredElementCollector(linkDoc)
                    .OfCategory(BuiltInCategory.OST_Rooms)
                    .WhereElementIsNotElementType()
                    .Cast<Room>())
                {
                    if (!_phaseAgnostic && !SpatialPhaseMatches(room, linkedPhase))
                    {
                        skippedLinkedPhase++;
                        continue;
                    }
                    var loops = GetBoundaryLoops(room, transform);
                    if (loops.Count == 0) continue;
                    if (!TryGetSpatialVerticalRange(room, transform, out var baseZ, out var topZ))
                    {
                        _warnings.Add($"Skipped linked Room {ElementIdCompat.GetValue(room.Id)} in '{linkName}' because its vertical extent was unavailable.");
                        continue;
                    }
                    var roomId = ElementIdCompat.GetValue(room.Id);
                    var roomPhaseId = _phaseAgnostic
                        ? GetSpatialPhaseId(room)
                        : ElementIdCompat.GetValue(linkedPhase.Id);
                    var applicableHostPhaseIds = new List<long>();
                    if (_phaseAgnostic && roomPhaseId.HasValue)
                        hostPhaseIdsByLinkedPhase.TryGetValue(roomPhaseId.Value, out applicableHostPhaseIds);
                    else if (!_phaseAgnostic && _hostPhase != null)
                        applicableHostPhaseIds.Add(ElementIdCompat.GetValue(_hostPhase.Id));
                    result.Add(new SpatialCandidate
                    {
                        Element = room,
                        SpatialKind = "Room",
                        SourceScope = "linked",
                        LinkInstanceId = linkId,
                        LinkInstanceName = linkName,
                        SourceDocumentTitle = linkTitle,
                        SpatialId = roomId,
                        SourceScopedId = $"{linkId}:{roomId}",
                        Number = room.Number,
                        Name = room.Name,
                        LevelName = GetLevelName(linkDoc, room),
                        LevelElevationFt = GetLevelElevation(linkDoc, room.LevelId, transform),
                        PhaseId = roomPhaseId,
                        PhaseName = _phaseAgnostic ? GetSpatialPhaseName(linkDoc, room) : linkedPhase.Name,
                        ApplicableHostPhaseIds = applicableHostPhaseIds ?? new List<long>(),
                        SourceToHost = transform,
                        HostToSource = inverse,
                        BaseElevationFt = baseZ,
                        TopElevationFt = topZ,
                        BoundaryLoops = loops
                    });
                }
                if (!_phaseAgnostic && skippedLinkedPhase > 0)
                    _warnings.Add($"Skipped {skippedLinkedPhase} Room records in link '{linkName}' outside mapped phase '{linkedPhase.Name}'.");
            }
        }

        private List<SpatialCandidate> BuildAssociationCandidates(Element element)
        {
            var spatials = new List<SpatialElement>();
            if (element is SpatialElement spatial && SpatialPhaseMatches(spatial, _hostPhase))
                spatials.Add(spatial);
            if (element is FamilyInstance family && _hostPhase != null)
            {
                try { if (family.get_Room(_hostPhase) != null) spatials.Add(family.get_Room(_hostPhase)); } catch { }
                try { if (family.get_FromRoom(_hostPhase) != null) spatials.Add(family.get_FromRoom(_hostPhase)); } catch { }
                try { if (family.get_ToRoom(_hostPhase) != null) spatials.Add(family.get_ToRoom(_hostPhase)); } catch { }
                try { if (family.get_Space(_hostPhase) != null) spatials.Add(family.get_Space(_hostPhase)); } catch { }
            }

            return spatials
                .Where(x => x != null)
                .GroupBy(x => $"{x.Document?.Title}|{ElementIdCompat.GetValue(x.Id)}")
                .Select(group =>
                {
                    var value = group.First();
                    return new SpatialCandidate
                    {
                        Element = value,
                        SpatialKind = value is Room ? "Room" : value is Space ? "Space" : "SpatialElement",
                        SourceScope = "host",
                        SourceDocumentTitle = _doc.Title,
                        SpatialId = ElementIdCompat.GetValue(value.Id),
                        SourceScopedId = $"host:{ElementIdCompat.GetValue(value.Id)}",
                        Number = GetNumber(value),
                        Name = GetName(value),
                        LevelName = GetLevelName(_doc, value),
                        LevelElevationFt = GetLevelElevation(_doc, value.LevelId, Transform.Identity),
                        PhaseId = GetSpatialPhaseId(value),
                        PhaseName = _hostPhase?.Name,
                        ApplicableHostPhaseIds = _hostPhase != null
                            ? new List<long> { ElementIdCompat.GetValue(_hostPhase.Id) }
                            : new List<long>(),
                        Method = "association",
                        BoundaryDistanceFt = 0,
                        LevelDeltaFt = 0
                    };
                })
                .ToList();
        }

        private List<SpatialCandidate> ChoosePreferredCandidates(
            List<SpatialCandidate> association,
            List<SpatialCandidate> containing)
        {
            if (_preference == "all")
                return association.Concat(containing).ToList();

            if (_preference == "auto" && association.Count > 0)
            {
                var associatedRooms = association.Where(x => x.SpatialKind == "Room").ToList();
                return associatedRooms.Count > 0
                    ? associatedRooms
                    : association.Where(x => x.SpatialKind == "Space").ToList();
            }

            var associatedPreferred = FilterPreference(association, _preference);
            if (associatedPreferred.Count > 0) return associatedPreferred;

            var containedPreferred = FilterPreference(containing, _preference);
            if (containedPreferred.Count > 0) return containedPreferred;

            if (_preference == "auto")
            {
                var rooms = containing.Where(x => x.SpatialKind == "Room").ToList();
                return rooms.Count > 0
                    ? rooms
                    : containing.Where(x => x.SpatialKind == "Space").ToList();
            }
            return new List<SpatialCandidate>();
        }

        private List<SpatialCandidate> ChooseNearestPreference(List<SpatialCandidate> nearest)
        {
            if (_preference == "all") return nearest;
            var preferred = FilterPreference(nearest, _preference);
            if (preferred.Count > 0) return preferred;
            if (_preference == "auto")
            {
                var rooms = nearest.Where(x => x.SpatialKind == "Room").ToList();
                return rooms.Count > 0
                    ? rooms
                    : nearest.Where(x => x.SpatialKind == "Space").ToList();
            }
            return new List<SpatialCandidate>();
        }

        private static List<SpatialCandidate> FilterPreference(
            IEnumerable<SpatialCandidate> candidates,
            string preference)
        {
            return preference switch
            {
                "room" => candidates.Where(x => x.SpatialKind == "Room").ToList(),
                "space" => candidates.Where(x => x.SpatialKind == "Space").ToList(),
                _ => new List<SpatialCandidate>()
            };
        }

        private bool AcceptsCandidate(SpatialCandidate candidate)
        {
            if (!SpatialCandidateFilterUtil.SourceIsEnabled(
                    candidate.SpatialKind,
                    candidate.SourceScope,
                    _includeHostRooms,
                    _includeHostSpaces,
                    _includeLinkedRooms))
                return false;
            if (_preference == "room") return candidate.SpatialKind == "Room";
            if (_preference == "space") return candidate.SpatialKind == "Space";
            return candidate.SpatialKind == "Room" || candidate.SpatialKind == "Space";
        }

        private Dictionary<long, bool> BuildElementLifecyclePresence(Element element)
        {
            var result = new Dictionary<long, bool>();
            if (!_phaseAgnostic) return result;
            foreach (var hostPhaseId in _geometryCandidates
                .SelectMany(candidate => candidate.ApplicableHostPhaseIds)
                .Where(value => value > 0)
                .Distinct())
            {
                var isPresent = false;
                try
                {
                    var phase = _doc.GetElement(ElementIdCompat.Create(hostPhaseId)) as Phase;
                    if (phase != null)
                        isPresent = SpatialElementLifecycleUtil.IsPresentInEffectivePhase(
                            element.GetPhaseStatus(phase.Id).ToString());
                }
                catch { }
                result[hostPhaseId] = isPresent;
            }
            return result;
        }

        private bool CandidateAppliesToElementLifecycle(
            SpatialCandidate candidate,
            IReadOnlyDictionary<long, bool> lifecyclePresenceByHostPhase)
        {
            if (!_phaseAgnostic) return true;
            if (!SpatialPhaseVariantProvenanceUtil.IsValid(candidate.PhaseId, candidate.ApplicableHostPhaseIds))
                return false;
            return SpatialElementLifecycleUtil.HasAnyApplicablePresentPhase(
                candidate.ApplicableHostPhaseIds
                    .Distinct()
                    .Select(hostPhaseId => lifecyclePresenceByHostPhase.TryGetValue(hostPhaseId, out var isPresent) && isPresent));
        }

        private List<CollapsedCandidate> Collapse(List<SpatialCandidate> values)
        {
            var exact = values
                .GroupBy(x => x.IdentityKey)
                .Select(group => new CollapsedCandidate
                {
                    Primary = group
                        .OrderBy(x => x.Method == "association" ? 0 : 1)
                        .ThenBy(x => x.BoundaryDistanceFt ?? double.PositiveInfinity)
                        .First(),
                    EquivalentSourceIds = group
                        .Select(x => x.SourceScopedId)
                        .Where(x => !string.IsNullOrWhiteSpace(x))
                        .Cast<string>()
                        .Distinct(StringComparer.OrdinalIgnoreCase)
                        .OrderBy(x => x)
                        .ToList(),
                    EquivalentPhaseNames = group
                        .Select(x => x.PhaseName)
                        .Where(x => !string.IsNullOrWhiteSpace(x))
                        .Cast<string>()
                        .Distinct(StringComparer.OrdinalIgnoreCase)
                        .OrderBy(x => x)
                        .ToList()
                })
                .ToList();

            if (!_phaseAgnostic) return OrderCollapsed(exact);

            var merged = new List<CollapsedCandidate>();
            foreach (var group in exact.GroupBy(value => PhaseVariantKey(value.Primary)))
            {
                if (string.IsNullOrWhiteSpace(group.Key) ||
                    !SpatialPhaseVariantProvenanceUtil.CanMerge(group.Select(value => value.Primary.PhaseId)))
                {
                    merged.AddRange(group);
                    continue;
                }

                var variants = group.ToList();
                merged.Add(new CollapsedCandidate
                {
                    Primary = variants
                        .OrderBy(value => value.Primary.BoundaryDistanceFt ?? double.PositiveInfinity)
                        .ThenBy(value => value.Primary.PhaseName)
                        .Select(value => value.Primary)
                        .First(),
                    EquivalentSourceIds = variants
                        .SelectMany(value => value.EquivalentSourceIds)
                        .Distinct(StringComparer.OrdinalIgnoreCase)
                        .OrderBy(value => value)
                        .ToList(),
                    EquivalentPhaseNames = variants
                        .SelectMany(value => value.EquivalentPhaseNames)
                        .Distinct(StringComparer.OrdinalIgnoreCase)
                        .OrderBy(value => value)
                        .ToList()
                });
            }
            return OrderCollapsed(merged);
        }

        private static List<CollapsedCandidate> OrderCollapsed(IEnumerable<CollapsedCandidate> values)
        {
            return values
                .OrderBy(x => x.Primary.Number)
                .ThenBy(x => x.Primary.Name)
                .ToList();
        }

        private static string PhaseVariantKey(SpatialCandidate candidate) =>
            SpatialPhaseVariantIdentityUtil.Build(
                candidate.SpatialKind,
                candidate.SourceScope,
                candidate.LinkInstanceId,
                candidate.SourceDocumentTitle ?? string.Empty,
                candidate.Number ?? string.Empty,
                candidate.Name ?? string.Empty,
                candidate.LevelName ?? string.Empty);

        private static SpatialCandidatePayload ToPayload(CollapsedCandidate collapsed)
        {
            var candidate = collapsed.Primary;
            return new SpatialCandidatePayload
            {
                spatialKind = candidate.SpatialKind,
                number = candidate.Number,
                name = candidate.Name,
                levelName = candidate.LevelName,
                spatialId = candidate.SpatialId,
                sourceScopedId = candidate.SourceScopedId,
                sourceScope = candidate.SourceScope,
                linkInstanceId = candidate.LinkInstanceId,
                linkInstanceName = candidate.LinkInstanceName,
                sourceDocumentTitle = candidate.SourceDocumentTitle,
                phaseId = candidate.PhaseId,
                phaseName = candidate.PhaseName,
                method = candidate.Method,
                boundaryDistanceFt = candidate.BoundaryDistanceFt,
                levelDeltaFt = candidate.LevelDeltaFt,
                equivalentSourceIds = collapsed.EquivalentSourceIds,
                equivalentPhaseNames = collapsed.EquivalentPhaseNames
            };
        }

        private static SpatialCandidate Clone(SpatialCandidate source)
        {
            return new SpatialCandidate
            {
                Element = source.Element,
                SpatialKind = source.SpatialKind,
                SourceScope = source.SourceScope,
                LinkInstanceId = source.LinkInstanceId,
                LinkInstanceName = source.LinkInstanceName,
                SourceDocumentTitle = source.SourceDocumentTitle,
                SpatialId = source.SpatialId,
                SourceScopedId = source.SourceScopedId,
                Number = source.Number,
                Name = source.Name,
                LevelName = source.LevelName,
                LevelElevationFt = source.LevelElevationFt,
                PhaseId = source.PhaseId,
                PhaseName = source.PhaseName,
                ApplicableHostPhaseIds = source.ApplicableHostPhaseIds.ToList(),
                Method = source.Method,
                BoundaryLoops = source.BoundaryLoops,
                SourceToHost = source.SourceToHost,
                HostToSource = source.HostToSource,
                BaseElevationFt = source.BaseElevationFt,
                TopElevationFt = source.TopElevationFt,
                BoundaryDistanceFt = source.BoundaryDistanceFt,
                LevelDeltaFt = source.LevelDeltaFt
            };
        }

        private static List<IReadOnlyList<SpatialPoint2>> GetBoundaryLoops(
            SpatialElement spatial,
            Transform transform)
        {
            var result = new List<IReadOnlyList<SpatialPoint2>>();
            try
            {
                var options = new SpatialElementBoundaryOptions
                {
                    SpatialElementBoundaryLocation = SpatialElementBoundaryLocation.Finish
                };
                var loops = spatial.GetBoundarySegments(options);
                if (loops == null) return result;
                foreach (var loop in loops)
                {
                    var points = new List<SpatialPoint2>();
                    var invalidLoop = false;
                    foreach (var segment in loop)
                    {
                        var curve = segment?.GetCurve();
                        if (curve == null)
                        {
                            invalidLoop = true;
                            break;
                        }

                        IList<XYZ> tessellated;
                        try { tessellated = curve.Tessellate(); }
                        catch
                        {
                            invalidLoop = true;
                            break;
                        }

                        foreach (var sourcePoint in tessellated)
                        {
                            var point = transform.OfPoint(sourcePoint);
                            var next = new SpatialPoint2(point.X, point.Y);
                            if (points.Count == 0 || DistanceSquared(points[points.Count - 1], next) > 1e-16)
                                points.Add(next);
                        }
                    }
                    if (points.Count > 1 && DistanceSquared(points[0], points[points.Count - 1]) <= 1e-16)
                        points.RemoveAt(points.Count - 1);
                    if (!invalidLoop && points.Count >= 3) result.Add(points);
                }
            }
            catch
            {
                // An unbounded or invalid spatial element is not evidence for a
                // match. Skip it and keep resolving against the remaining set.
            }
            return result;
        }

        private static double DistanceSquared(SpatialPoint2 a, SpatialPoint2 b)
        {
            var dx = a.X - b.X;
            var dy = a.Y - b.Y;
            return (dx * dx) + (dy * dy);
        }

        private static bool TryGetRepresentativePoint(Element element, out XYZ point)
        {
            if (element.Location is LocationPoint locationPoint)
            {
                point = locationPoint.Point;
                return point != null;
            }
            if (element.Location is LocationCurve locationCurve)
            {
                try
                {
                    point = locationCurve.Curve.Evaluate(0.5, true);
                    return point != null;
                }
                catch { }
            }

            try
            {
                var bounds = element.get_BoundingBox(null);
                if (bounds != null)
                {
                    point = (bounds.Min + bounds.Max) * 0.5;
                    return true;
                }
            }
            catch { }

            point = XYZ.Zero;
            return false;
        }

        private static double? ResolveElementLevelElevation(Document doc, Element element)
        {
            try
            {
                if (element.LevelId != null && element.LevelId != ElementId.InvalidElementId)
                {
                    var level = doc.GetElement(element.LevelId) as Level;
                    if (level != null) return level.Elevation;
                }
            }
            catch { }

            foreach (var parameter in new[]
            {
                element.get_Parameter(BuiltInParameter.FAMILY_LEVEL_PARAM),
                element.get_Parameter(BuiltInParameter.INSTANCE_REFERENCE_LEVEL_PARAM),
                element.LookupParameter("Schedule Level"),
                element.LookupParameter("Level"),
                element.LookupParameter("Reference Level")
            })
            {
                try
                {
                    if (parameter == null || parameter.StorageType != StorageType.ElementId) continue;
                    var level = doc.GetElement(parameter.AsElementId()) as Level;
                    if (level != null) return level.Elevation;
                }
                catch { }
            }
            return null;
        }

        private static bool VerticalRangeMatches(double z, SpatialCandidate candidate)
        {
            return SpatialVerticalRangeUtil.Contains(
                z,
                candidate.BaseElevationFt,
                candidate.TopElevationFt,
                BoundaryToleranceFt);
        }

        private static bool IsPointInsideSpatialVolume(SpatialCandidate candidate, XYZ hostPoint)
        {
            if (candidate.Element == null) return false;
            XYZ sourcePoint;
            try { sourcePoint = candidate.HostToSource.OfPoint(hostPoint); }
            catch { return false; }

            try
            {
                if (candidate.Element is Room room) return room.IsPointInRoom(sourcePoint);
                if (candidate.Element is Space space) return space.IsPointInSpace(sourcePoint);
            }
            catch { }
            return false;
        }

        private static double? Delta(double? a, double? b)
        {
            if (!a.HasValue || !b.HasValue) return null;
            return Math.Abs(a.Value - b.Value);
        }

        private static double? GetLevelElevation(Document doc, ElementId levelId, Transform transform)
        {
            try
            {
                var level = doc.GetElement(levelId) as Level;
                if (level == null) return null;
                return transform.OfPoint(new XYZ(0, 0, level.Elevation)).Z;
            }
            catch { return null; }
        }

        private static string? GetLevelName(Document doc, SpatialElement spatial)
        {
            try { return (doc.GetElement(spatial.LevelId) as Level)?.Name; }
            catch { return null; }
        }

        private static string? GetNumber(SpatialElement spatial)
        {
            return spatial switch
            {
                Room room => room.Number,
                Space space => space.Number,
                _ => null
            };
        }

        private static string? GetName(SpatialElement spatial)
        {
            return spatial switch
            {
                Room room => room.Name,
                Space space => space.Name,
                _ => spatial.Name
            };
        }

        private static long? GetSpatialPhaseId(SpatialElement spatial)
        {
            try
            {
                var parameter = spatial.get_Parameter(BuiltInParameter.ROOM_PHASE);
                if (parameter != null && parameter.StorageType == StorageType.ElementId)
                {
                    var id = parameter.AsElementId();
                    if (id != null && id != ElementId.InvalidElementId)
                        return ElementIdCompat.GetValue(id);
                }
            }
            catch { }

            try
            {
                if (spatial.CreatedPhaseId != null && spatial.CreatedPhaseId != ElementId.InvalidElementId)
                    return ElementIdCompat.GetValue(spatial.CreatedPhaseId);
            }
            catch { }
            return null;
        }

        private static string? GetSpatialPhaseName(Document doc, SpatialElement spatial)
        {
            var phaseId = GetSpatialPhaseId(spatial);
            if (!phaseId.HasValue) return null;
            try { return (doc.GetElement(ElementIdCompat.Create(phaseId.Value)) as Phase)?.Name; }
            catch { return null; }
        }

        private static bool SpatialPhaseMatches(SpatialElement spatial, Phase? phase)
        {
            if (phase == null) return false;
            var spatialPhaseId = GetSpatialPhaseId(spatial);
            return spatialPhaseId.HasValue && spatialPhaseId.Value == ElementIdCompat.GetValue(phase.Id);
        }

        private static bool TryGetSpatialVerticalRange(
            SpatialElement spatial,
            Transform sourceToHost,
            out double baseElevation,
            out double topElevation)
        {
            baseElevation = 0;
            topElevation = 0;
            try
            {
                double sourceBase;
                double sourceTop;
                if (spatial is Room room && room.Level != null)
                {
                    sourceBase = room.Level.Elevation + room.BaseOffset;
                    sourceTop = room.UpperLimit != null
                        ? room.UpperLimit.Elevation + room.LimitOffset
                        : sourceBase + room.UnboundedHeight;
                }
                else if (spatial is Space space && space.Level != null)
                {
                    sourceBase = space.Level.Elevation + space.BaseOffset;
                    sourceTop = space.UpperLimit != null
                        ? space.UpperLimit.Elevation + space.LimitOffset
                        : sourceBase + space.UnboundedHeight;
                }
                else
                {
                    return false;
                }

                var hostBase = sourceToHost.OfPoint(new XYZ(0, 0, sourceBase)).Z;
                var hostTop = sourceToHost.OfPoint(new XYZ(0, 0, sourceTop)).Z;
                baseElevation = Math.Min(hostBase, hostTop);
                topElevation = Math.Max(hostBase, hostTop);
                return topElevation - baseElevation > BoundaryToleranceFt;
            }
            catch { return false; }
        }

        private static bool TryGetLinkTransform(
            RevitLinkInstance link,
            out Transform sourceToHost,
            out Transform hostToSource)
        {
            sourceToHost = null!;
            hostToSource = null!;
            try { sourceToHost = link.GetTotalTransform(); }
            catch
            {
                try { sourceToHost = link.GetTransform(); }
                catch { return false; }
            }

            try
            {
                hostToSource = sourceToHost.Inverse;
                return hostToSource != null;
            }
            catch { return false; }
        }

        private Dictionary<long, List<long>> BuildHostPhaseIdsByLinkedPhase(RevitLinkInstance link)
        {
            return TryReadLinkedPhasePairs(link)
                .Where(pair => pair.Key > 0 && pair.Value > 0 &&
                    _doc.GetElement(ElementIdCompat.Create(pair.Key)) is Phase)
                .GroupBy(pair => pair.Value)
                .ToDictionary(
                    group => group.Key,
                    group => group.Select(pair => pair.Key).Distinct().OrderBy(value => value).ToList());
        }

        private Phase? TryResolveLinkedPhase(
            RevitLinkInstance link,
            Document linkDoc,
            Phase? hostPhase)
        {
            if (hostPhase == null) return null;
            var hostId = ElementIdCompat.GetValue(hostPhase.Id);
            var linkedId = SpatialPhaseMapUtil.ResolveLinkedPhaseId(hostId, TryReadLinkedPhasePairs(link));
            return linkedId.HasValue
                ? linkDoc.GetElement(ElementIdCompat.Create(linkedId.Value)) as Phase
                : null;
        }

        private List<KeyValuePair<long, long>> TryReadLinkedPhasePairs(RevitLinkInstance link)
        {
            RevitLinkType? linkType = null;
            try { linkType = _doc.GetElement(link.GetTypeId()) as RevitLinkType; }
            catch { }
            if (linkType == null) return new List<KeyValuePair<long, long>>();

            try
            {
                var method = linkType.GetType().GetMethod(
                    "GetPhaseMap",
                    BindingFlags.Instance | BindingFlags.Public,
                    null,
                    Type.EmptyTypes,
                    null);
                if (method == null || !(method.Invoke(linkType, null) is IEnumerable map))
                    return new List<KeyValuePair<long, long>>();

                var pairs = new List<KeyValuePair<long, long>>();
                foreach (var entry in map)
                {
                    var key = TryReadElementIdProperty(entry, "Key");
                    var value = TryReadElementIdProperty(entry, "Value");
                    if (key != null && value != null)
                        pairs.Add(new KeyValuePair<long, long>(
                            ElementIdCompat.GetValue(key),
                            ElementIdCompat.GetValue(value)));
                }
                return pairs;
            }
            catch { }
            return new List<KeyValuePair<long, long>>();
        }

        private static ElementId? TryReadElementIdProperty(object target, string propertyName)
        {
            try
            {
                return target.GetType()
                    .GetProperty(propertyName, BindingFlags.Instance | BindingFlags.Public)?
                    .GetValue(target, null) as ElementId;
            }
            catch { return null; }
        }

        private static bool MatchesContains(string value, string? filter)
        {
            if (string.IsNullOrWhiteSpace(filter)) return true;
            return value.IndexOf(filter.Trim(), StringComparison.OrdinalIgnoreCase) >= 0;
        }

        private static string NormalizePreference(string? value)
        {
            var normalized = (value ?? "auto").Trim().ToLowerInvariant();
            return normalized == "room" || normalized == "space" || normalized == "all"
                ? normalized
                : "auto";
        }
    }
}
