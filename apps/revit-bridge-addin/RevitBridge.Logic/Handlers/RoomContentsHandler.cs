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
    public class RoomContentsHandler : IRequestHandler
    {
        public sealed class Params
        {
            public string roomNumber { get; set; } = "";
            public List<string>? categories { get; set; }
            public List<string>? includeKeywords { get; set; }
            public List<string>? excludeKeywords { get; set; }
            public bool includeLinked { get; set; } = true;
            public string mode { get; set; } = "roomAware"; // auto | roomAware | geometry
            public string verticalScope { get; set; } = "room"; // room | plenum | room+plenum
            public string spatialKindPreference { get; set; } = "auto"; // auto | room | space
            public double? plenumMaxZ { get; set; } // optional explicit max Z (feet); otherwise uses next level elevation if available
            public string? systemClassification { get; set; } // Supply|Return|Exhaust|Any (best-effort exact match unless Any)
            public bool includeConnectedOutsideRoom { get; set; } = false;
            public int? limit { get; set; } = 20000;
        }

        public Task<object> Handle(UIApplication app, string jsonData)
        {
            var p = string.IsNullOrWhiteSpace(jsonData) ? new Params() : JsonSerializer.Deserialize<Params>(jsonData);
            var uidoc = app.ActiveUIDocument;
            if (uidoc == null) throw new InvalidOperationException("No active UI document.");
            var doc = uidoc.Document;

            var roomNumber = (p?.roomNumber ?? "").Trim();
            if (string.IsNullOrWhiteSpace(roomNumber)) throw new ArgumentException("roomNumber is required.");

            var mode = (p?.mode ?? "").Trim();
            if (string.IsNullOrWhiteSpace(mode)) mode = "roomAware";
            var modeOrder = new List<string>();
            if (mode.Equals("auto", StringComparison.OrdinalIgnoreCase))
            {
                // Hybrid mode: prefer room-aware checks, then geometry fallback for MEP/non-room-aware categories.
                modeOrder.Add("roomAware");
                modeOrder.Add("geometry");
            }
            else if (mode.Equals("roomAware", StringComparison.OrdinalIgnoreCase))
            {
                modeOrder.Add("roomAware");
            }
            else if (mode.Equals("geometry", StringComparison.OrdinalIgnoreCase))
            {
                modeOrder.Add("geometry");
            }
            else
            {
                throw new ArgumentException("mode must be 'auto', 'roomAware', or 'geometry'.");
            }

            var vScope = (p?.verticalScope ?? "").Trim();
            if (string.IsNullOrWhiteSpace(vScope)) vScope = "room";
            var scopeOrder = new List<string>();
            if (vScope.Equals("room", StringComparison.OrdinalIgnoreCase))
            {
                scopeOrder.Add("room");
            }
            else if (vScope.Equals("plenum", StringComparison.OrdinalIgnoreCase))
            {
                scopeOrder.Add("plenum");
            }
            else if (vScope.Equals("room+plenum", StringComparison.OrdinalIgnoreCase) ||
                     vScope.Equals("both", StringComparison.OrdinalIgnoreCase))
            {
                scopeOrder.Add("room");
                scopeOrder.Add("plenum");
            }
            else
            {
                throw new ArgumentException("verticalScope must be 'room', 'plenum', or 'room+plenum'.");
            }

            var spatialPref = (p?.spatialKindPreference ?? "").Trim();
            if (string.IsNullOrWhiteSpace(spatialPref)) spatialPref = "auto";
            if (!spatialPref.Equals("auto", StringComparison.OrdinalIgnoreCase) &&
                !spatialPref.Equals("room", StringComparison.OrdinalIgnoreCase) &&
                !spatialPref.Equals("space", StringComparison.OrdinalIgnoreCase))
            {
                throw new ArgumentException("spatialKindPreference must be 'auto', 'room', or 'space'.");
            }

            var warnings = new List<string>();

            var resolved = SpatialElementResolver.ResolveByNumber(doc, roomNumber, spatialPref);
            var spatial = resolved.Element;
            if (spatial == null) throw new InvalidOperationException($"Room/Space '{roomNumber}' not found.");
            var spatialBoundary = RoomHandler.BuildSpatialBoundaryExport(spatial, view: null, includeBoundaryElementIds: true);
            if (spatialBoundary.warnings.Count > 0) warnings.AddRange(spatialBoundary.warnings);

            // Vertical ranges (feet, model coords)
            var baseZ = TryGetSpatialBaseZ(spatial, out var bz) ? bz : 0.0;
            var topZ = TryGetSpatialTopZ(spatial, out var tz) ? tz : (baseZ + 10.0);
            var plenumMinZ = topZ;
            var plenumMaxZ = p?.plenumMaxZ ?? TryGetNextLevelElevation(doc, spatial) ?? (topZ + 20.0);
            if (plenumMaxZ < plenumMinZ) plenumMaxZ = plenumMinZ;

            var include = (p?.includeKeywords ?? new List<string>()).Where(x => !string.IsNullOrWhiteSpace(x)).Select(x => x.Trim()).ToList();
            var exclude = (p?.excludeKeywords ?? new List<string>()).Where(x => !string.IsNullOrWhiteSpace(x)).Select(x => x.Trim()).ToList();

            var requestedCats = (p?.categories ?? new List<string>())
                .Where(x => !string.IsNullOrWhiteSpace(x))
                .Select(x => x.Trim())
                .ToList();

            var bicList = new List<BuiltInCategory>();
            var unknownCats = new List<string>();
            foreach (var c in requestedCats)
            {
                if (TryResolveCategory(c, out var bic)) bicList.Add(bic);
                else unknownCats.Add(c);
            }
            if (unknownCats.Count > 0)
                warnings.Add($"Unrecognized category tokens were matched by exact category name only when possible: {string.Join(", ", unknownCats)}");

            var collector = new FilteredElementCollector(doc).WhereElementIsNotElementType();
            if (bicList.Count == 1) collector.OfCategory(bicList[0]);
            else if (bicList.Count > 1) collector.WherePasses(new ElementMulticategoryFilter(bicList));
            var requestedCatIds = new HashSet<long>(bicList.Select(x => (long)(int)x));
            int? collectorCount = null;
            try { collectorCount = collector.GetElementCount(); } catch { /* ignore */ }

            var cap = p?.limit.HasValue == true && p.limit.Value > 0 ? Math.Min(p.limit.Value, 200000) : 20000;
            var systemClassification = (p?.systemClassification ?? "").Trim();
            var includeConnectedOutside = p?.includeConnectedOutsideRoom == true;

            var matched = new List<long>();
            var matchedScopedIds = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            var byCategoryCounts = new Dictionary<string, int>(StringComparer.OrdinalIgnoreCase);
            var candidateByCategoryCounts = new Dictionary<string, int>(StringComparer.OrdinalIgnoreCase);
            var filteredBySystemCategoryCounts = new Dictionary<string, int>(StringComparer.OrdinalIgnoreCase);
            var unclassified = new List<object>();
            var unclassifiedCap = 400;
            var unclassifiedReasonCounts = new Dictionary<string, int>(StringComparer.OrdinalIgnoreCase);
            var candidateElementIdsPreSystem = new List<long>();
            var candidateScopedIdsPreSystem = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            const int candidateElementIdsCap = 400;
            var elements = new List<object>();
            const int elementsCap = 120;
            var candidateSpatialCount = 0;
            var systemFilteredOutCount = 0;
            var linkedModelCount = 0;
            var linkedScanned = 0;
            var linkedMatchedCount = 0;

            int scanned = 0;
            foreach (var e in collector)
            {
                if (e == null) continue;
                if (e.Id == spatial.Id) continue;

                scanned++;
                if (scanned > cap)
                {
                    var totalText = collectorCount.HasValue ? collectorCount.Value.ToString() : "unknown";
                    warnings.Add($"Scan limit reached ({cap}) after scanning {cap} post-category candidates (collectorCount={totalText}).");
                    break;
                }

                if (requestedCats.Count > 0 && !SelectionUtil.MatchesCategoryFilter(e, requestedCats)) continue;
                if (!MatchesKeywords(doc, e, include, exclude)) continue;

                var inSpatialScope = false;
                string failReason = "NotInRoom";
                foreach (var modeAttempt in modeOrder)
                {
                    foreach (var scopeAttempt in scopeOrder)
                    {
                        string reason;
                        bool isPlenumAttempt = scopeAttempt.Equals("plenum", StringComparison.OrdinalIgnoreCase);
                        bool isRoomAwareAttempt = modeAttempt.Equals("roomAware", StringComparison.OrdinalIgnoreCase) && !isPlenumAttempt;
                        if (isRoomAwareAttempt)
                        {
                            if (TryIsInRoomRoomAware(e, spatial, out reason))
                            {
                                inSpatialScope = true;
                                failReason = "";
                                break;
                            }
                        }
                        else
                        {
                            if (TryIsInRoomGeometry(e, spatial, baseZ, isPlenumAttempt ? plenumMinZ : (double?)null, isPlenumAttempt ? plenumMaxZ : (double?)null, out reason))
                            {
                                inSpatialScope = true;
                                failReason = "";
                                break;
                            }
                        }
                        if (!string.IsNullOrWhiteSpace(reason)) failReason = reason;
                    }
                    if (inSpatialScope) break;
                }

                if (!inSpatialScope)
                {
                    if (!string.IsNullOrWhiteSpace(failReason))
                    {
                        BumpReasonCount(failReason, unclassifiedReasonCounts);
                        if (ShouldIncludeUnclassifiedSample(failReason) && unclassified.Count < unclassifiedCap)
                            unclassified.Add(new { id = RevitBridge.Common.ElementIdCompat.GetValue(e.Id), reason = failReason });
                    }
                    continue;
                }

                candidateSpatialCount++;
                BumpCategoryCount(e, candidateByCategoryCounts);
                if (candidateElementIdsPreSystem.Count < candidateElementIdsCap) candidateElementIdsPreSystem.Add(RevitBridge.Common.ElementIdCompat.GetValue(e.Id));
                candidateScopedIdsPreSystem.Add(DatasetExportUtil.CreateSourceScopedId(e, null));

                if (!MatchesSystemClassification(e, systemClassification))
                {
                    systemFilteredOutCount++;
                    BumpCategoryCount(e, filteredBySystemCategoryCounts);
                    continue;
                }

                matched.Add(RevitBridge.Common.ElementIdCompat.GetValue(e.Id));
                matchedScopedIds.Add(DatasetExportUtil.CreateSourceScopedId(e, null));
                BumpCategoryCount(e, byCategoryCounts);
                if (elements.Count < elementsCap) elements.Add(BuildMatchedElementPayload(doc, e, null, spatial));
            }

            if (p?.includeLinked == true)
            {
                warnings.Add("Linked elements are classified against the active-model room/space using transformed geometry. Link/view visibility controls are best-effort in this export path.");
                var linkInstances = new FilteredElementCollector(doc)
                    .OfClass(typeof(RevitLinkInstance))
                    .Cast<RevitLinkInstance>()
                    .ToList();

                foreach (var linkInstance in linkInstances)
                {
                    Document? linkDoc = null;
                    try { linkDoc = linkInstance.GetLinkDocument(); } catch { linkDoc = null; }
                    if (linkDoc == null)
                    {
                        warnings.Add($"Linked model '{linkInstance.Name}' is unloaded or inaccessible; linked export skipped for that instance.");
                        continue;
                    }

                    linkedModelCount++;
                    var linkedCollector = new FilteredElementCollector(linkDoc).WhereElementIsNotElementType();
                    if (bicList.Count == 1) linkedCollector.OfCategory(bicList[0]);
                    else if (bicList.Count > 1) linkedCollector.WherePasses(new ElementMulticategoryFilter(bicList));

                    foreach (var linkedElement in linkedCollector)
                    {
                        if (linkedElement == null) continue;

                        scanned++;
                        linkedScanned++;
                        if (scanned > cap)
                        {
                            warnings.Add($"Scan limit reached ({cap}) while traversing linked models.");
                            break;
                        }

                        if (requestedCats.Count > 0 && !SelectionUtil.MatchesCategoryFilter(linkedElement, requestedCats)) continue;
                        if (!MatchesKeywords(linkDoc, linkedElement, include, exclude)) continue;

                        var inSpatialScope = false;
                        string failReason = "NotInRoom";
                        foreach (var scopeAttempt in scopeOrder)
                        {
                            var isPlenumAttempt = scopeAttempt.Equals("plenum", StringComparison.OrdinalIgnoreCase);
                            if (TryIsInRoomGeometry(linkedElement, spatial, baseZ, isPlenumAttempt ? plenumMinZ : (double?)null, isPlenumAttempt ? plenumMaxZ : (double?)null, out var reason, linkInstance))
                            {
                                inSpatialScope = true;
                                failReason = "";
                                break;
                            }

                            if (!string.IsNullOrWhiteSpace(reason)) failReason = reason;
                        }

                        if (!inSpatialScope)
                        {
                            if (!string.IsNullOrWhiteSpace(failReason))
                            {
                                BumpReasonCount(failReason, unclassifiedReasonCounts);
                                if (ShouldIncludeUnclassifiedSample(failReason) && unclassified.Count < unclassifiedCap)
                                {
                                    unclassified.Add(new
                                    {
                                        id = ElementIdCompat.GetValue(linkedElement.Id),
                                        sourceScopedId = DatasetExportUtil.CreateSourceScopedId(linkedElement, linkInstance),
                                        source = "linked",
                                        reason = failReason
                                    });
                                }
                            }
                            continue;
                        }

                        candidateSpatialCount++;
                        BumpCategoryCount(linkedElement, candidateByCategoryCounts);
                        var scopedCandidateId = DatasetExportUtil.CreateSourceScopedId(linkedElement, linkInstance);
                        if (!string.IsNullOrWhiteSpace(scopedCandidateId)) candidateScopedIdsPreSystem.Add(scopedCandidateId);

                        if (!MatchesSystemClassification(linkedElement, systemClassification))
                        {
                            systemFilteredOutCount++;
                            BumpCategoryCount(linkedElement, filteredBySystemCategoryCounts);
                            continue;
                        }

                        linkedMatchedCount++;
                        matchedScopedIds.Add(scopedCandidateId);
                        BumpCategoryCount(linkedElement, byCategoryCounts);
                        if (elements.Count < elementsCap) elements.Add(BuildMatchedElementPayload(doc, linkedElement, linkInstance, spatial));
                    }

                    if (scanned > cap) break;
                }
            }

            var connectedOutsideRoomIds = new List<long>();
            if (includeConnectedOutside && matched.Count > 0)
            {
                var matchedSet = new HashSet<long>(matched);
                var expanded = new HashSet<long>();
                foreach (var id in matched)
                {
                    var e = doc.GetElement(RevitBridge.Common.ElementIdCompat.Create(id));
                    if (e == null) continue;
                    foreach (var next in MepSystemUtil.GetConnectedOwnerElementIds(e))
                    {
                        if (next == null || next.IntegerValue <= 0) continue;
                        if (matchedSet.Contains(RevitBridge.Common.ElementIdCompat.GetValue(next))) continue;

                        var other = doc.GetElement(next);
                        if (other == null) continue;
                        if (!MatchesSystemClassification(other, systemClassification)) continue;
                        var otherCatId = RevitBridge.Common.ElementIdCompat.GetValue(other.Category?.Id);
                        if (requestedCatIds.Count > 0 && !requestedCatIds.Contains(otherCatId)) continue;
                        expanded.Add(RevitBridge.Common.ElementIdCompat.GetValue(next));
                    }
                }
                connectedOutsideRoomIds = expanded.OrderBy(x => x).ToList();
                foreach (var id in connectedOutsideRoomIds)
                {
                    var e = doc.GetElement(RevitBridge.Common.ElementIdCompat.Create(id));
                    if (e == null) continue;
                    BumpCategoryCount(e, byCategoryCounts);
                }
            }

            if (unclassifiedReasonCounts.Count > 0)
            {
                var noAssociation = new[] { "NoRoomAssociation", "RoomAwareNotSupportedForCategory", "NotInRoom", "NotInFootprint" }
                    .Sum(key => unclassifiedReasonCounts.TryGetValue(key, out var count) ? count : 0);
                if (noAssociation > 0)
                {
                    warnings.Add($"Some elements were excluded due to missing/unsupported room association or spatial miss (count={noAssociation}).");
                }
            }
            if (!string.IsNullOrWhiteSpace(systemClassification) && candidateSpatialCount > 0 && systemFilteredOutCount > 0)
            {
                warnings.Add($"System classification '{systemClassification}' excluded {systemFilteredOutCount} spatial candidates.");
            }

            if (unclassified.Count >= unclassifiedCap) warnings.Add($"unclassified truncated to {unclassifiedCap} entries.");
            if (elements.Count >= elementsCap && matched.Distinct().Count() > elementsCap)
                warnings.Add($"elements truncated to {elementsCap} detailed rows.");

            return Task.FromResult<object>(new
            {
                status = "Ok",
                roomId = RevitBridge.Common.ElementIdCompat.GetValue(spatial.Id),
                roomNumber = resolved.Number.Length > 0 ? resolved.Number : GetSpatialNumber(spatial),
                spatialKind = resolved.SpatialKind.Length > 0 ? resolved.SpatialKind : (spatial is Room ? "Room" : (spatial is Space ? "Space" : "SpatialElement")),
                resolvedSpatial = new
                {
                    id = RevitBridge.Common.ElementIdCompat.GetValue(spatial.Id),
                    type = resolved.SpatialKind.Length > 0 ? resolved.SpatialKind : (spatial is Room ? "Room" : (spatial is Space ? "Space" : "SpatialElement")),
                    number = resolved.Number.Length > 0 ? resolved.Number : GetSpatialNumber(spatial),
                    confidence = resolved.Confidence,
                    matchMode = resolved.MatchMode
                },
                location = spatialBoundary.location,
                boundaryLoops = spatialBoundary.boundaryLoops,
                boundary = spatialBoundary.boundary,
                mode = mode.Equals("auto", StringComparison.OrdinalIgnoreCase) ? "auto" : modeOrder.First(),
                verticalScope = scopeOrder.Count > 1 ? "room+plenum" : scopeOrder.First(),
                modeOrder,
                verticalScopeOrder = scopeOrder,
                spatialKindPreference = spatialPref,
                includeLinked = p?.includeLinked == true,
                systemClassification = systemClassification.Length > 0 ? systemClassification : null,
                includeConnectedOutsideRoom = includeConnectedOutside,
                verticalRange = scopeOrder.Any(x => x.Equals("plenum", StringComparison.OrdinalIgnoreCase)) ? new { minZ = plenumMinZ, maxZ = plenumMaxZ, note = "feet, model Z" } : null,
                elementIds = matched.Distinct().OrderBy(x => x).ToList(),
                sourceScopedElementIds = matchedScopedIds.OrderBy(x => x).ToList(),
                connectedOutsideRoomIds,
                byCategoryCounts,
                byCategoryCandidatePreSystem = candidateByCategoryCounts,
                byCategoryFilteredBySystem = filteredBySystemCategoryCounts,
                candidateElementIdsPreSystem = candidateElementIdsPreSystem.Distinct().OrderBy(x => x).ToList(),
                candidateSourceScopedIdsPreSystem = candidateScopedIdsPreSystem.OrderBy(x => x).ToList(),
                elements,
                diagnostics = new
                {
                    collectorCount,
                    scanned,
                    linkedScanned,
                    linkedModelCount,
                    scanLimit = cap,
                    candidateSpatialCount,
                    systemFilteredOutCount,
                    matchedCount = matched.Distinct().Count(),
                    matchedScopedCount = matchedScopedIds.Count,
                    linkedMatchedCount,
                    matchedIncludingConnected = matched.Distinct().Count() + connectedOutsideRoomIds.Count,
                    unclassifiedReasonCounts
                },
                unclassified = unclassified.Count > 0 ? unclassified : null,
                warnings
            });
        }

        private static void BumpCategoryCount(Element e, Dictionary<string, int> counts)
        {
            var key = e.Category?.Name ?? "None";
            if (counts.TryGetValue(key, out var v)) counts[key] = v + 1;
            else counts[key] = 1;
        }

        private static bool MatchesKeywords(Document doc, Element e, List<string> include, List<string> exclude)
        {
            if ((include == null || include.Count == 0) && (exclude == null || exclude.Count == 0)) return true;

            var t = GetSearchText(doc, e);
            if (exclude != null && exclude.Count > 0)
            {
                foreach (var k in exclude)
                {
                    if (k.Length == 0) continue;
                    if (t.IndexOf(k, StringComparison.OrdinalIgnoreCase) >= 0) return false;
                }
            }

            if (include != null && include.Count > 0)
            {
                foreach (var k in include)
                {
                    if (k.Length == 0) continue;
                    if (t.IndexOf(k, StringComparison.OrdinalIgnoreCase) >= 0) return true;
                }
                return false;
            }

            return true;
        }

        private static bool TryResolveCategory(string raw, out BuiltInCategory bic)
        {
            if (BuiltInCategoryTokenUtil.TryParse(raw, out bic)) return true;

            var key = (raw ?? "").Trim().ToLowerInvariant();
            var normalized = new string(key.Where(ch => char.IsLetterOrDigit(ch)).ToArray());
            switch (normalized)
            {
                case "ducts":
                case "ductcurve":
                case "ductcurves":
                    bic = BuiltInCategory.OST_DuctCurves;
                    return true;
                case "ductfitting":
                case "ductfittings":
                case "fittings":
                    bic = BuiltInCategory.OST_DuctFitting;
                    return true;
                case "ductterminal":
                case "ductterminals":
                case "airterminal":
                case "airterminals":
                case "terminals":
                    bic = BuiltInCategory.OST_DuctTerminal;
                    return true;
                case "mechanicalequipment":
                case "equipment":
                    bic = BuiltInCategory.OST_MechanicalEquipment;
                    return true;
                default:
                    return false;
            }
        }

        private static void BumpReasonCount(string reason, Dictionary<string, int> counts)
        {
            if (string.IsNullOrWhiteSpace(reason)) return;
            if (counts.TryGetValue(reason, out var cur)) counts[reason] = cur + 1;
            else counts[reason] = 1;
        }

        private static string GetSearchText(Document doc, Element e)
        {
            var parts = new List<string>
            {
                e.Name ?? "",
                e.Category?.Name ?? ""
            };

            try
            {
                var typeId = e.GetTypeId();
                if (typeId != ElementId.InvalidElementId)
                {
                    if (doc.GetElement(typeId) is ElementType et)
                    {
                        parts.Add(et.Name ?? "");
                        parts.Add(et.FamilyName ?? "");
                    }
                    if (doc.GetElement(typeId) is FamilySymbol fs)
                    {
                        parts.Add(fs.FamilyName ?? "");
                    }
                }
            }
            catch { }

            try
            {
                var mark = e.get_Parameter(BuiltInParameter.ALL_MODEL_MARK)?.AsString()
                    ?? e.LookupParameter("Mark")?.AsString();
                if (!string.IsNullOrWhiteSpace(mark)) parts.Add(mark);
            }
            catch { }

            return string.Join(" | ", parts.Where(x => !string.IsNullOrWhiteSpace(x)));
        }

        private static bool ShouldIncludeUnclassifiedSample(string reason)
        {
            if (string.IsNullOrWhiteSpace(reason)) return false;
            return !string.Equals(reason, "NotInRoom", StringComparison.OrdinalIgnoreCase)
                && !string.Equals(reason, "NotInFootprint", StringComparison.OrdinalIgnoreCase)
                && !string.Equals(reason, "NoRoomAssociation", StringComparison.OrdinalIgnoreCase)
                && !string.Equals(reason, "RoomAwareNotSupportedForCategory", StringComparison.OrdinalIgnoreCase);
        }

        private static object BuildMatchedElementPayload(
            Document doc,
            Element element,
            RevitLinkInstance? linkInstance = null,
            SpatialElement? associatedSpatial = null)
        {
            return DatasetExportUtil.BuildCommonElementPayload(doc, element, linkInstance, associatedSpatial);
        }

        private static bool TryIsInRoomRoomAware(Element e, SpatialElement spatial, out string reason)
        {
            reason = "";
            try
            {
                if (e is FamilyInstance fi)
                {
                    // Primary association.
                    if (fi.Room != null && fi.Room.Id == spatial.Id) return true;

                    try
                    {
                        var sp = fi.Space;
                        if (sp != null && sp.Id == spatial.Id) return true;
                    }
                    catch { }

                    // Doors/windows often use FromRoom/ToRoom.
                    try
                    {
                        if (spatial is Room)
                        {
                            if (fi.FromRoom != null && fi.FromRoom.Id == spatial.Id) return true;
                            if (fi.ToRoom != null && fi.ToRoom.Id == spatial.Id) return true;
                        }
                    }
                    catch { }

                    reason = "NoRoomAssociation";
                    // Fall back to best-effort point tests (covers many MEP families where Room/Space association isn't populated).
                    if (TryIsPointInSpatialFromLocation(e, spatial, out _)) return true;
                    return false;
                }
            }
            catch
            {
                reason = "RoomAssociationError";
                return false;
            }

            // Ducts/MEP curves are typically LocationCurve-based (not Room-aware), so we do a best-effort midpoint test.
            if (TryIsPointInSpatialFromLocation(e, spatial, out var why))
            {
                reason = "";
                return true;
            }

            reason = why ?? "RoomAwareNotSupportedForCategory";
            return false;
        }

        private static bool TryIsPointInSpatialFromLocation(
            Element e,
            SpatialElement spatial,
            out string? reason,
            RevitLinkInstance? linkInstance = null)
        {
            reason = null;
            try
            {
                XYZ? p = null;
                if (e.Location is LocationPoint lp && lp.Point != null)
                {
                    p = lp.Point;
                }
                else if (e.Location is LocationCurve lc && lc.Curve != null)
                {
                    try { p = lc.Curve.Evaluate(0.5, true); } catch { p = null; }
                }

                if (p == null)
                {
                    reason = "NoLocation";
                    return false;
                }

                p = DatasetExportUtil.TransformPointToHost(linkInstance, p);

                if (spatial is Room r) return r.IsPointInRoom(p);
                if (spatial is Space s) return s.IsPointInSpace(p);

                reason = "UnknownSpatialKind";
                return false;
            }
            catch
            {
                reason = "LocationPointTestError";
                return false;
            }
        }

        private static bool TryIsInRoomGeometry(
            Element e,
            SpatialElement spatial,
            double baseZ,
            double? minZ,
            double? maxZ,
            out string reason,
            RevitLinkInstance? linkInstance = null)
        {
            reason = "";

            try
            {
                var points = GetTestPoints(e, linkInstance);
                if (points.Count == 0)
                {
                    reason = "NoLocation";
                    return false;
                }

                foreach (var p in points)
                {
                    try
                    {
                        // Plenum scope: project XY into the room footprint at baseZ, and then apply vertical gating.
                        if (minZ.HasValue || maxZ.HasValue)
                        {
                            if (!IsPointInFootprint(spatial, new XYZ(p.X, p.Y, baseZ + 0.1)))
                            {
                                reason = "NotInFootprint";
                                continue;
                            }

                            var z = p.Z;
                            if (minZ.HasValue && z < minZ.Value) { reason = "BelowMinZ"; continue; }
                            if (maxZ.HasValue && z > maxZ.Value) { reason = "AboveMaxZ"; continue; }
                            return true;
                        }

                        if (spatial is Room r)
                        {
                            if (r.IsPointInRoom(p)) return true;
                        }
                        else if (spatial is Space s)
                        {
                            if (s.IsPointInSpace(p)) return true;
                        }
                    }
                    catch
                    {
                        // ignore point errors (some rooms can throw for bad points)
                    }
                }

                reason = "NotInRoom";
                return false;
            }
            catch
            {
                reason = "GeometryCheckError";
                return false;
            }
        }

        private static List<XYZ> GetTestPoints(Element e, RevitLinkInstance? linkInstance = null)
        {
            var pts = new List<XYZ>();
            try
            {
                if (e.Location is LocationPoint lp && lp.Point != null)
                {
                    pts.Add(DatasetExportUtil.TransformPointToHost(linkInstance, lp.Point));
                    return pts;
                }

                if (e.Location is LocationCurve lc && lc.Curve != null)
                {
                    var c = lc.Curve;
                    var p0 = DatasetExportUtil.TransformPointToHost(linkInstance, c.GetEndPoint(0));
                    var p1 = DatasetExportUtil.TransformPointToHost(linkInstance, c.GetEndPoint(1));
                    pts.Add(p0);
                    pts.Add(p1);
                    pts.Add((p0 + p1) * 0.5);
                    return pts;
                }
            }
            catch
            {
                // fall back to bbox
            }

            try
            {
                var bb = DatasetExportUtil.TryGetBoundingBoxInHostCoordinates(e, null, linkInstance);
                if (bb != null)
                {
                    pts.Add((bb.Min + bb.Max) * 0.5);
                }
            }
            catch { }

            return pts;
        }

        private static bool IsPointInFootprint(SpatialElement spatial, XYZ p)
        {
            try
            {
                if (spatial is Room r) return r.IsPointInRoom(p);
                if (spatial is Space s) return s.IsPointInSpace(p);
            }
            catch { }
            return false;
        }

        private static bool TryGetSpatialBaseZ(SpatialElement spatial, out double baseZ)
        {
            baseZ = 0.0;
            try
            {
                if (spatial is Room r && r.Level != null)
                {
                    baseZ = r.Level.Elevation + r.BaseOffset;
                    return true;
                }
            }
            catch { }

            try
            {
                // Space often has a level, but base offset isn't exposed consistently; fall back to bbox.
                var bb = spatial.get_BoundingBox(null);
                if (bb != null)
                {
                    baseZ = bb.Min.Z;
                    return true;
                }
            }
            catch { }

            return false;
        }

        private static bool TryGetSpatialTopZ(SpatialElement spatial, out double topZ)
        {
            topZ = 0.0;
            try
            {
                if (spatial is Room r && r.Level != null)
                {
                    var baseZ = r.Level.Elevation + r.BaseOffset;
                    if (r.UpperLimit != null)
                    {
                        topZ = r.UpperLimit.Elevation + r.LimitOffset;
                        return true;
                    }

                    try
                    {
                        topZ = baseZ + r.UnboundedHeight;
                        return true;
                    }
                    catch
                    {
                        topZ = baseZ + 10.0;
                        return true;
                    }
                }
            }
            catch { }

            try
            {
                var bb = spatial.get_BoundingBox(null);
                if (bb != null)
                {
                    topZ = bb.Max.Z;
                    return true;
                }
            }
            catch { }

            return false;
        }

        private static double? TryGetNextLevelElevation(Document doc, SpatialElement spatial)
        {
            try
            {
                var baseLevel = (spatial as Room)?.Level;
                if (baseLevel == null) return null;
                var elev = baseLevel.Elevation;
                var levels = new FilteredElementCollector(doc)
                    .OfClass(typeof(Level))
                    .Cast<Level>()
                    .OrderBy(l => l.Elevation)
                    .ToList();
                foreach (var l in levels)
                {
                    if (l == null) continue;
                    if (l.Elevation > elev + 1e-6) return l.Elevation;
                }
            }
            catch { }
            return null;
        }

        private static bool MatchesSystemClassification(Element e, string? required)
        {
            return MepSystemUtil.ElementMatchesSystemClassification(e, required);
        }

        private static string GetSpatialNumber(SpatialElement spatial)
        {
            try
            {
                if (spatial is Room r) return r.Number;
                if (spatial is Space s) return s.Number;
            }
            catch { }
            return "";
        }
    }
}
