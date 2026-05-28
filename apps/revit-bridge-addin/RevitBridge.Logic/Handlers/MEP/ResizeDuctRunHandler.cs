using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Text.Json;
using System.Threading.Tasks;
using Autodesk.Revit.DB;
using Autodesk.Revit.DB.Mechanical;
using Autodesk.Revit.UI;
using RevitBridge.Logic.Handlers.Core;
using RevitBridge.Common;

namespace RevitBridge.Logic.Handlers.MEP
{
    public class ResizeDuctRunHandler : IRequestHandler
    {
        public sealed class Params
        {
            public long startElementId { get; set; }
            public string targetDiameter { get; set; } = "";
            public double? targetDiameterFt { get; set; } // optional override; if provided, treated as internal feet

            public string? systemName { get; set; }
            public bool inferSystemFromStart { get; set; } = true;

            // Intended default: resize a "run" up to transitions/branches/terminations.
            // If scope="selectedOnly", only resize the seed element (if it is a duct curve).
            public string scope { get; set; } = "run"; // "run" | "selectedOnly"

            // Boundary controls (best-effort). Defaults match expected user intent for "resize run".
            public bool stopAtBranchFittings { get; set; } = true;
            public bool stopAtTransitions { get; set; } = true;
            public bool includeTerminals { get; set; } = true;
            public bool includeEquipment { get; set; } = true;
            public bool eliminateTransitions { get; set; } = false; // try to remove size transitions by resolving type-driven terminals/equipment when possible

            public int maxElements { get; set; } = 5000;
            public bool dryRun { get; set; } = true;
            public string? confirm { get; set; }
        }

        private sealed class ElementAnalysis
        {
            public long id { get; set; }
            public string category { get; set; } = "";
            public string name { get; set; } = "";
            public string? systemName { get; set; }

            public bool isDuctCurve { get; set; }
            public bool isRound { get; set; }

            public string? diameterBefore { get; set; }
            public string? diameterAfter { get; set; }

            public bool instanceResizable { get; set; }
            public List<string> instanceResizableParameters { get; set; } = new List<string>();

            public bool typeDriven { get; set; }
            public long? typeId { get; set; }
            public string? typeName { get; set; }
            public int? typeUseCount { get; set; }
            public List<string> candidateTypeParameters { get; set; } = new List<string>();
        }

        public Task<object> Handle(UIApplication app, string jsonData)
        {
            var p = string.IsNullOrWhiteSpace(jsonData) ? new Params() : (JsonSerializer.Deserialize<Params>(jsonData) ?? new Params());
            if (p.startElementId <= 0) throw new ArgumentException("startElementId is required.");
            var targetStr = (p.targetDiameter ?? "").Trim();
            if ((!p.targetDiameterFt.HasValue || p.targetDiameterFt.Value <= 0) && targetStr.Length == 0)
                throw new ArgumentException("Provide targetDiameter (e.g. \"6\\\"\" or \"150mm\") or targetDiameterFt (in feet).");

            var uidoc = app.ActiveUIDocument;
            if (uidoc == null) throw new InvalidOperationException("No active UI document.");
            var doc = uidoc.Document;

            var start = doc.GetElement(RevitBridge.Common.ElementIdCompat.Create(p.startElementId));
            if (start == null) throw new InvalidOperationException($"Element {p.startElementId} not found.");

            var targetDiameterFt = 0.0;
            if (p.targetDiameterFt.HasValue && p.targetDiameterFt.Value > 0)
            {
                targetDiameterFt = p.targetDiameterFt.Value;
            }
            else
            {
                if (!TryParseLengthLoose(doc, targetStr, out targetDiameterFt, out var parseErr))
                {
                    throw new InvalidOperationException($"Could not parse targetDiameter: {parseErr}");
                }
            }
            if (targetDiameterFt <= 0) throw new InvalidOperationException("targetDiameter must be > 0.");

            var warnings = new List<string>();
            var systemFilter = (p.systemName ?? "").Trim();
            string? inferredSystem = null;
            if (systemFilter.Length == 0 && p.inferSystemFromStart)
            {
                inferredSystem = MepSystemUtil.TryGetSystemName(start);
                if (!string.IsNullOrWhiteSpace(inferredSystem)) systemFilter = inferredSystem!;
            }

            var max = p.maxElements <= 0 ? 5000 : Math.Min(p.maxElements, 50000);

            var scope = (p.scope ?? "").Trim();
            if (scope.Length == 0) scope = "run";
            if (!scope.Equals("run", StringComparison.OrdinalIgnoreCase) && !scope.Equals("selectedOnly", StringComparison.OrdinalIgnoreCase))
            {
                throw new ArgumentException("scope must be \"run\" or \"selectedOnly\".");
            }

            var run = new RunTraceResult();
            if (scope.Equals("selectedOnly", StringComparison.OrdinalIgnoreCase))
            {
                run.ElementIdsOrdered.Add(RevitBridge.Common.ElementIdCompat.GetValue(start.Id));
                run.VisitedCount = 1;
            }
            else
            {
                run = TraceRun(doc, start, systemFilter, p.stopAtBranchFittings, p.stopAtTransitions, includeTerminals: p.includeTerminals, includeEquipment: p.includeEquipment, maxElements: max, warnings: warnings);
            }

            var elementIds = run.ElementIdsOrdered.Distinct().ToList();
            if (elementIds.Count == 0) throw new InvalidOperationException("No elements found in run.");

            // Analyze elements.
            var typeUseCountCache = new Dictionary<long, int>();
            var analyses = new List<ElementAnalysis>();
            var ductsToResize = new List<long>();

            foreach (var id in elementIds)
            {
                var e = doc.GetElement(RevitBridge.Common.ElementIdCompat.Create(id));
                if (e == null) continue;

                var catToken = SelectionUtil.GetCategoryToken(e) ?? (e.Category?.Name ?? "None");
                var sys = MepSystemUtil.TryGetSystemName(e);
                var a = new ElementAnalysis
                {
                    id = RevitBridge.Common.ElementIdCompat.GetValue(e.Id),
                    category = catToken,
                    name = e.Name ?? "",
                    systemName = sys
                };

                a.isDuctCurve = IsDuctCurve(e);
                if (a.isDuctCurve)
                {
                    a.isRound = IsRoundDuctLike(e);
                    a.diameterBefore = a.isRound ? TryFormatCurrentDiameter(doc, e) : null;
                    a.diameterAfter = a.isRound ? FormatLength(doc, targetDiameterFt) : null;

                    var (instOk, instParams) = GetInstanceResizableParamsForRound(e);
                    a.instanceResizable = instOk;
                    a.instanceResizableParameters = instParams;

                    if (a.isRound && instOk) ductsToResize.Add(RevitBridge.Common.ElementIdCompat.GetValue(e.Id));
                }
                else
                {
                    var (instOk, instParams) = GetInstanceResizableParamsForRound(e);
                    a.instanceResizable = instOk;
                    a.instanceResizableParameters = instParams;

                    if (!instOk)
                    {
                        // Heuristic: if the element has connectors but lacks writable size params, treat as type-driven.
                        var hasConn = false;
                        try { hasConn = MepSystemUtil.GetConnectors(e).Any(); } catch { hasConn = false; }
                        a.typeDriven = hasConn && IsFamilyInstance(e);
                    }

                    if (a.typeDriven)
                    {
                        try
                        {
                            var typeId = e.GetTypeId();
                            if (typeId != null && typeId.IntegerValue > 0)
                            {
                                var type = doc.GetElement(typeId) as ElementType;
                                if (type != null)
                                {
                                    a.typeId = RevitBridge.Common.ElementIdCompat.GetValue(type.Id);
                                    a.typeName = type.Name;
                                    a.typeUseCount = GetTypeUseCount(doc, type.Id, typeUseCountCache);
                                    a.candidateTypeParameters = FindCandidateTypeSizeParameters(type).ToList();
                                }
                            }
                        }
                        catch { }
                    }
                }

                analyses.Add(a);
            }

            if (!p.dryRun && ductsToResize.Count > 50)
            {
                var requiredConfirm = BulkConfirmUtil.ExpectedApplyChanges(ductsToResize.Count);
                if (!BulkConfirmUtil.EqualsNormalized(p.confirm, requiredConfirm))
                {
                    throw new OperatorToolUserErrorException(
                        message: "Bulk duct resize requires typed confirmation.",
                        code: "bulk_confirm_required",
                        requiredConfirm: requiredConfirm,
                        confirmReceived: BulkConfirmUtil.Normalize(p.confirm),
                        maxChangesPerCall: 50,
                        hint: "Retry with confirm set to the requiredConfirm string (exact, but markdown like **...** is ok).");
                }
            }

            object? applyResult = null;
            object? syncResult = null;
            object? postConnectivityAudit = null;
            var missingAfter = new List<long>();

            if (!p.dryRun)
            {
                using (var tg = new TransactionGroup(doc, "Resize Duct Run"))
                {
                    tg.Start();
                    applyResult = ApplyResize(doc, ductsToResize, targetDiameterFt);

                    try { doc.Regenerate(); } catch { }
                    try { uidoc.RefreshActiveView(); } catch { }

                    // After resizing duct curves, attempt best-effort fitting/terminal sync within the traced run.
                    try
                    {
                        var maxSyncPasses = 3;
                        var lastSyncChangedCount = 0;
                        var syncPasses = new List<object>();
                        object? lastPassResult = null;
                        for (var pass = 1; pass <= maxSyncPasses; pass++)
                        {
                            var syncParams = new SyncConnectedSizesHandler.Params
                            {
                                elementIds = elementIds,
                                dryRun = false,
                                maxElements = max,
                                resolveTypeDriven = p.eliminateTransitions ? "auto" : "skip",
                                confirm = p.confirm
                            };
                            var syncJson = JsonSerializer.Serialize(syncParams);
                            var passResult = new SyncConnectedSizesHandler().Handle(app, syncJson).GetAwaiter().GetResult();
                            var changedThisPass = ReadSyncChangedCount(passResult);

                            syncPasses.Add(new
                            {
                                pass,
                                changedCount = changedThisPass,
                                result = passResult
                            });

                            lastPassResult = passResult;
                            lastSyncChangedCount = changedThisPass;

                            if (changedThisPass <= 0) break;
                            try { doc.Regenerate(); } catch { }
                        }

                        if (lastSyncChangedCount > 0)
                        {
                            warnings.Add($"sync-connected-sizes did not converge after {maxSyncPasses} passes; remaining changedCount={lastSyncChangedCount}.");
                        }

                        syncResult = syncPasses.Count <= 1
                            ? lastPassResult
                            : new
                            {
                                converged = lastSyncChangedCount <= 0,
                                maxPasses = maxSyncPasses,
                                passes = syncPasses
                            };
                    }
                    catch (Exception ex)
                    {
                        warnings.Add($"sync-connected-sizes failed: {ex.Message}");
                    }

                    tg.Assimilate();
                }

                // Post-apply: check for missing ids (elements that may have been regenerated/replaced).
                foreach (var id in elementIds)
                {
                    try
                    {
                        if (doc.GetElement(RevitBridge.Common.ElementIdCompat.Create(id)) == null) missingAfter.Add(id);
                    }
                    catch { }
                }

                // Post-apply: continuity audit (connected trace vs system membership).
                try
                {
                    var auditParams = new TraceConnectedNetworkHandler.Params
                    {
                        startElementId = p.startElementId,
                        systemName = systemFilter.Length > 0 ? systemFilter : null,
                        inferSystemFromStart = true,
                        stopAtBranchFittings = false,
                        stopAtTransitions = false,
                        includeDucts = true,
                        includeFittings = true,
                        includeAccessories = true,
                        includeTerminals = true,
                        includeEquipment = true,
                        includeOtherCategories = false,
                        maxElements = max,
                        includeSystemAudit = true,
                        systemAuditMaxElements = 20000
                    };
                    var auditJson = JsonSerializer.Serialize(auditParams);
                    postConnectivityAudit = new TraceConnectedNetworkHandler().Handle(app, auditJson).GetAwaiter().GetResult();
                }
                catch (Exception ex)
                {
                    warnings.Add($"post connectivity audit failed: {ex.Message}");
                }
            }

            return Task.FromResult<object>(new
            {
                status = p.dryRun ? "Dry Run" : "Applied",
                dryRun = p.dryRun,
                startElementId = p.startElementId,
                systemName = systemFilter.Length > 0 ? systemFilter : null,
                inferredSystemName = inferredSystem,
                scope,
                target = new
                {
                    diameter = FormatLength(doc, targetDiameterFt),
                    diameterFt = targetDiameterFt
                },
                traversal = new
                {
                    stopAtBranchFittings = p.stopAtBranchFittings,
                    stopAtTransitions = p.stopAtTransitions,
                    includeTerminals = p.includeTerminals,
                    includeEquipment = p.includeEquipment,
                    eliminateTransitions = p.eliminateTransitions,
                    maxElements = max
                },
                trace = new
                {
                    visitedCount = run.VisitedCount,
                    elementIdsOrdered = elementIds,
                    boundaryStops = run.BoundaryStops,
                    boundaryNotes = run.BoundaryNotes
                },
                ductResize = new
                {
                    ductsTargetedCount = ductsToResize.Count,
                    ductsTargeted = ductsToResize
                },
                elements = analyses,
                applyResult,
                syncResult,
                missingAfterElementIds = missingAfter,
                postConnectivityAudit,
                warnings
            });
        }

        private sealed class RunTraceResult
        {
            public int VisitedCount { get; set; }
            public List<long> ElementIdsOrdered { get; } = new List<long>();
            public List<object> BoundaryStops { get; } = new List<object>();
            public List<string> BoundaryNotes { get; } = new List<string>();
        }

        private static RunTraceResult TraceRun(Document doc, Element start, string? systemFilter, bool stopAtBranchFittings, bool stopAtTransitions, bool includeTerminals, bool includeEquipment, int maxElements, List<string> warnings)
        {
            var run = new RunTraceResult();

            var visited = new HashSet<int>();
            var queue = new Queue<(ElementId id, int depth)>();
            queue.Enqueue((start.Id, 0));

            while (queue.Count > 0 && visited.Count < maxElements)
            {
                var (id, depth) = queue.Dequeue();
                if (id == null) continue;
                if (!visited.Add(id.IntegerValue)) continue;

                var e = doc.GetElement(id);
                if (e == null) continue;

                var sysName = MepSystemUtil.TryGetSystemName(e);
                if (!MepSystemUtil.SystemNameMatches(sysName, systemFilter) && !string.IsNullOrWhiteSpace(systemFilter))
                {
                    // Do not prune traversal purely because an element lacks a system name (common for equipment).
                    if (!string.IsNullOrWhiteSpace(sysName)) continue;
                }

                var catId = RevitBridge.Common.ElementIdCompat.GetValue(e.Category?.Id);
                var isTerminal = catId == (int)BuiltInCategory.OST_DuctTerminal;
                var isEquipment = catId == (int)BuiltInCategory.OST_MechanicalEquipment;
                var isDuctCurve = catId == (int)BuiltInCategory.OST_DuctCurves;
                var isFitting = catId == (int)BuiltInCategory.OST_DuctFitting;
                var isAccessory = catId == (int)BuiltInCategory.OST_DuctAccessory;

                // Only include relevant MEP graph nodes.
                var isRelevant = isDuctCurve || isFitting || isAccessory || (includeTerminals && isTerminal) || (includeEquipment && isEquipment);
                if (!isRelevant) continue;

                run.ElementIdsOrdered.Add(RevitBridge.Common.ElementIdCompat.GetValue(e.Id));

                var allowTraverseFurther = true;
                if (isTerminal) allowTraverseFurther = false;
                if (isEquipment && e.Id != start.Id) allowTraverseFurther = false;

                if (stopAtBranchFittings && isFitting && IsBranchFitting(e))
                {
                    allowTraverseFurther = false;
                    run.BoundaryStops.Add(new { elementId = RevitBridge.Common.ElementIdCompat.GetValue(e.Id), kind = "branch_fitting" });
                }

                if (stopAtTransitions && isFitting && IsTransitionFitting(e))
                {
                    allowTraverseFurther = false;
                    run.BoundaryStops.Add(new { elementId = RevitBridge.Common.ElementIdCompat.GetValue(e.Id), kind = "transition_fitting" });
                    run.BoundaryNotes.AddRange(GetTransitionEquipmentNotes(e).Select(x => x));
                }

                if (!allowTraverseFurther) continue;

                foreach (var nextId in MepSystemUtil.GetConnectedOwnerElementIds(e))
                {
                    if (visited.Count >= maxElements) break;
                    if (!visited.Contains(nextId.IntegerValue))
                    {
                        queue.Enqueue((nextId, depth + 1));
                    }
                }
            }

            run.VisitedCount = visited.Count;
            if (visited.Count >= maxElements)
            {
                warnings.Add($"Traversal reached maxElements={maxElements}; results may be truncated.");
            }

            if (run.ElementIdsOrdered.Count == 0)
            {
                warnings.Add("No connected duct elements found. Try starting from a duct segment/fitting that is definitely connected.");
            }

            return run;
        }

        private static object ApplyResize(Document doc, List<long> ductIds, double targetDiameterFt)
        {
            var changes = new List<object>();
            var skipped = new List<object>();
            var changedCount = 0;

            using (var t = new Transaction(doc, "Resize Ducts"))
            {
                t.Start();
                WarningSuppressionUtil.SuppressWarnings(t);
                foreach (var id in ductIds.Distinct())
                {
                    var e = doc.GetElement(RevitBridge.Common.ElementIdCompat.Create(id));
                    if (e == null)
                    {
                        skipped.Add(new { id, ok = false, error = "Element not found." });
                        continue;
                    }

                    var param = GetRoundDiameterParam(e);
                    if (param == null)
                    {
                        skipped.Add(new { id, ok = false, error = "No diameter parameter found on element." });
                        continue;
                    }
                    if (param.IsReadOnly)
                    {
                        skipped.Add(new { id, ok = false, error = "Diameter parameter is read-only." });
                        continue;
                    }

                    var before = ParameterValueUtil.SnapshotForWire(param);
                    var desired = FormatLength(doc, targetDiameterFt);
                    var didChange = false;
                    try
                    {
                        if (param.StorageType == StorageType.Double)
                        {
                            var existing = param.AsDouble();
                            didChange = Math.Abs(existing - targetDiameterFt) > 1e-9;
                            if (didChange) param.Set(targetDiameterFt);
                        }
                        else
                        {
                            if (!ParameterValueUtil.TrySetFromString(param, desired, out didChange, out var message))
                            {
                                changes.Add(new { id, ok = false, changed = false, error = message, before, after = before, desired });
                                continue;
                            }
                        }
                    }
                    catch (Exception ex)
                    {
                        changes.Add(new { id, ok = false, changed = false, error = ex.Message, before, after = before, desired });
                        continue;
                    }

                    var after = ParameterValueUtil.SnapshotForWire(param);
                    if (didChange) changedCount++;
                    changes.Add(new { id, ok = true, changed = didChange, before, after, desired, parameterName = param.Definition?.Name });
                }

                t.Commit();
            }

            return new
            {
                changedCount,
                requestedCount = ductIds.Distinct().Count(),
                changes,
                skipped
            };
        }

        private static bool IsFamilyInstance(Element e) => e is FamilyInstance;

        private static bool IsDuctCurve(Element e)
        {
            try { return RevitBridge.Common.ElementIdCompat.GetValue(e?.Category?.Id) == (int)BuiltInCategory.OST_DuctCurves; } catch { return false; }
        }

        private static bool IsRoundDuctLike(Element e)
        {
            try
            {
                foreach (var c in MepSystemUtil.GetConnectors(e))
                {
                    if (c == null) continue;
                    if (c.Shape == ConnectorProfileType.Round) return true;
                    if (c.Shape == ConnectorProfileType.Rectangular) return false;
                }
            }
            catch { }
            return false;
        }

        private static (bool ok, List<string> paramNames) GetInstanceResizableParamsForRound(Element e)
        {
            var outNames = new List<string>();
            var p = GetRoundDiameterParam(e);
            if (p == null) return (false, outNames);
            outNames.Add(p.Definition?.Name ?? "Diameter");
            if (p.IsReadOnly) return (false, outNames);
            return (true, outNames);
        }

        private static Parameter? GetRoundDiameterParam(Element e)
        {
            try
            {
                // Common for duct curves.
                var p = e.get_Parameter(BuiltInParameter.RBS_CURVE_DIAMETER_PARAM);
                if (p != null) return p;
            }
            catch { }

            try
            {
                return e.LookupParameter("Diameter") ?? e.LookupParameter("Nominal Diameter");
            }
            catch
            {
                return null;
            }
        }

        private static string? TryFormatCurrentDiameter(Document doc, Element e)
        {
            try
            {
                var p = GetRoundDiameterParam(e);
                if (p == null) return null;
                return p.AsValueString() ?? p.AsString();
            }
            catch
            {
                return null;
            }
        }

        private static IEnumerable<string> FindCandidateTypeSizeParameters(ElementType type)
        {
            var candidates = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            if (type == null) return candidates;

            // Common names seen on MEP terminals/fittings.
            var names = new[]
            {
                "Duct Size",
                "Duct Diameter",
                "Connector Diameter",
                "Diameter",
                "Nominal Diameter",
                "Size",
                "Width",
                "Height"
            };

            foreach (var n in names)
            {
                try
                {
                    var p = type.LookupParameter(n);
                    if (p == null) continue;
                    if (p.IsReadOnly) continue;
                    candidates.Add(n);
                }
                catch { }
            }

            return candidates.OrderBy(x => x).ToList();
        }

        private static int ReadSyncChangedCount(object? syncResult)
        {
            if (syncResult == null) return 0;
            try
            {
                using var doc = JsonDocument.Parse(JsonSerializer.Serialize(syncResult));
                if (doc.RootElement.TryGetProperty("changedCount", out var changed) &&
                    changed.ValueKind == JsonValueKind.Number &&
                    changed.TryGetInt32(out var changedCount))
                {
                    return Math.Max(0, changedCount);
                }

                return 0;
            }
            catch
            {
                return 0;
            }
        }

        private static int GetTypeUseCount(Document doc, ElementId typeId, Dictionary<long, int> cache)
        {
            if (doc == null || typeId == null) return 0;
            var typeKey = RevitBridge.Common.ElementIdCompat.GetValue(typeId);
            if (cache.TryGetValue(typeKey, out var v)) return v;
            try
            {
                // Best-effort: count family instances referencing this type.
                var count = new FilteredElementCollector(doc)
                    .OfClass(typeof(FamilyInstance))
                    .Cast<FamilyInstance>()
                    .Count(fi => fi?.Symbol?.Id == typeId);
                cache[typeKey] = count;
                return count;
            }
            catch
            {
                cache[typeKey] = 0;
                return 0;
            }
        }

        private static bool TryParseLengthLoose(Document doc, string input, out double lengthFt, out string error)
        {
            lengthFt = 0;
            error = "";
            try
            {
                var units = doc.GetUnits();
                if (UnitFormatUtils.TryParse(units, SpecTypeId.Length, input, out var v))
                {
                    lengthFt = v;
                    return true;
                }

                // Common manual forms that Revit's parser may reject in some unit settings.
                var raw = (input ?? "").Trim();
                if (raw.Length == 0)
                {
                    error = "Empty length string.";
                    return false;
                }

                // Inches (6", 6 in)
                if (raw.EndsWith("\"", StringComparison.OrdinalIgnoreCase) || raw.EndsWith("in", StringComparison.OrdinalIgnoreCase))
                {
                    var num = raw;
                    if (num.EndsWith("\"", StringComparison.OrdinalIgnoreCase))
                        num = num.Substring(0, num.Length - 1);
                    else if (num.EndsWith("in", StringComparison.OrdinalIgnoreCase))
                        num = num.Substring(0, num.Length - 2);
                    num = num.Trim();
                    if (double.TryParse(num, NumberStyles.Float, CultureInfo.InvariantCulture, out var inches) ||
                        double.TryParse(num, NumberStyles.Float, CultureInfo.CurrentCulture, out inches))
                    {
                        lengthFt = inches / 12.0;
                        return true;
                    }
                }

                // Feet (0.5', 0.5 ft)
                if (raw.EndsWith("'", StringComparison.OrdinalIgnoreCase) || raw.EndsWith("ft", StringComparison.OrdinalIgnoreCase))
                {
                    var num = raw;
                    if (num.EndsWith("'", StringComparison.OrdinalIgnoreCase))
                        num = num.Substring(0, num.Length - 1);
                    else if (num.EndsWith("ft", StringComparison.OrdinalIgnoreCase))
                        num = num.Substring(0, num.Length - 2);
                    num = num.Trim();
                    if (double.TryParse(num, NumberStyles.Float, CultureInfo.InvariantCulture, out var ft) ||
                        double.TryParse(num, NumberStyles.Float, CultureInfo.CurrentCulture, out ft))
                    {
                        lengthFt = ft;
                        return true;
                    }
                }

                // Metric (mm/cm/m) – treat as length.
                if (raw.EndsWith("mm", StringComparison.OrdinalIgnoreCase) ||
                    raw.EndsWith("cm", StringComparison.OrdinalIgnoreCase) ||
                    raw.EndsWith("m", StringComparison.OrdinalIgnoreCase))
                {
                    var isMm = raw.EndsWith("mm", StringComparison.OrdinalIgnoreCase);
                    var isCm = raw.EndsWith("cm", StringComparison.OrdinalIgnoreCase);
                    var isM = !isMm && !isCm && raw.EndsWith("m", StringComparison.OrdinalIgnoreCase);

                    var num = raw;
                    if (isMm || isCm)
                        num = raw.Substring(0, raw.Length - 2);
                    else if (isM)
                        num = raw.Substring(0, raw.Length - 1);
                    num = (num ?? "").Trim();

                    if (double.TryParse(num, NumberStyles.Float, CultureInfo.InvariantCulture, out var mv) ||
                        double.TryParse(num, NumberStyles.Float, CultureInfo.CurrentCulture, out mv))
                    {
                        var meters = isMm ? (mv / 1000.0) : isCm ? (mv / 100.0) : mv;
                        lengthFt = meters / 0.3048;
                        return true;
                    }
                }

                // Plain numeric: interpret as feet (explicitly requested).
                if (double.TryParse(raw, NumberStyles.Float, CultureInfo.InvariantCulture, out var plain) ||
                    double.TryParse(raw, NumberStyles.Float, CultureInfo.CurrentCulture, out plain))
                {
                    lengthFt = plain;
                    return true;
                }

                error = $"Invalid length string: \"{input}\".";
                return false;
            }
            catch (Exception ex)
            {
                error = ex.Message;
                return false;
            }
        }

        private static string FormatLength(Document doc, double lengthFt)
        {
            try
            {
                var units = doc.GetUnits();
                return UnitFormatUtils.Format(units, SpecTypeId.Length, lengthFt, forEditing: true);
            }
            catch
            {
                return lengthFt.ToString("G", CultureInfo.InvariantCulture);
            }
        }

        private static bool IsBranchFitting(Element e)
        {
            try
            {
                var catId = RevitBridge.Common.ElementIdCompat.GetValue(e.Category?.Id);
                if (catId != (int)BuiltInCategory.OST_DuctFitting) return false;
                var count = 0;
                foreach (var _ in MepSystemUtil.GetConnectors(e))
                {
                    count++;
                    if (count >= 3) return true;
                }
            }
            catch { }
            return false;
        }

        private static bool IsTransitionFitting(Element e)
        {
            try
            {
                var catId = RevitBridge.Common.ElementIdCompat.GetValue(e.Category?.Id);
                if (catId != (int)BuiltInCategory.OST_DuctFitting) return false;

                var sizes = new List<string>();
                foreach (var c in MepSystemUtil.GetConnectors(e))
                {
                    if (c == null) continue;
                    if (c.Shape == ConnectorProfileType.Round)
                    {
                        var d = 2.0 * c.Radius;
                        sizes.Add("r:" + d.ToString("G6", CultureInfo.InvariantCulture));
                    }
                    else if (c.Shape == ConnectorProfileType.Rectangular)
                    {
                        sizes.Add("x:" + c.Width.ToString("G6", CultureInfo.InvariantCulture) + "x" + c.Height.ToString("G6", CultureInfo.InvariantCulture));
                    }
                }

                var distinct = sizes.Distinct().Take(3).ToList();
                return distinct.Count >= 2;
            }
            catch { }
            return false;
        }

        private static IEnumerable<string> GetTransitionEquipmentNotes(Element transition)
        {
            var notes = new List<string>();
            try
            {
                foreach (var c in MepSystemUtil.GetConnectors(transition))
                {
                    if (c == null) continue;
                    ConnectorSet? refs = null;
                    try { refs = c.AllRefs; } catch { refs = null; }
                    if (refs == null) continue;
                    foreach (Connector r in refs)
                    {
                        var o = r?.Owner;
                        if (o == null) continue;
                        var catId = RevitBridge.Common.ElementIdCompat.GetValue(o.Category?.Id);
                        if (catId != (int)BuiltInCategory.OST_MechanicalEquipment) continue;

                        if (r.Shape == ConnectorProfileType.Round)
                        {
                            var d = 2.0 * r.Radius;
                            notes.Add($"Transition {RevitBridge.Common.ElementIdCompat.GetValue(transition.Id)} connects to Mechanical Equipment {RevitBridge.Common.ElementIdCompat.GetValue(o.Id)} with connector diameter {d.ToString("G", CultureInfo.InvariantCulture)}ft (equipment connectors are often fixed).");
                        }
                        else
                        {
                            notes.Add($"Transition {RevitBridge.Common.ElementIdCompat.GetValue(transition.Id)} connects to Mechanical Equipment {RevitBridge.Common.ElementIdCompat.GetValue(o.Id)} (equipment connectors are often fixed).");
                        }
                    }
                }
            }
            catch { }
            return notes.Distinct().ToList();
        }
    }
}
