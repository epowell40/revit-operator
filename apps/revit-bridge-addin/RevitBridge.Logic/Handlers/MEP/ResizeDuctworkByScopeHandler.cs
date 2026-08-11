using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Text;
using System.Text.Json;
using System.Threading.Tasks;
using Autodesk.Revit.DB;
using Autodesk.Revit.DB.Mechanical;
using Autodesk.Revit.UI;
using RevitBridge.Common;
using RevitBridge.Logic.Handlers;
using RevitBridge.Logic.Handlers.Core;

namespace RevitBridge.Logic.Handlers.MEP
{
    public sealed class ResizeDuctworkByScopeHandler : IRequestHandler
    {
        private const double SizeToleranceFt = 1e-5;
        private const double OpenConnectorMergeToleranceFt = 0.02; // ~1/4"

        public sealed class ScopeSpec
        {
            public string roomNumber { get; set; } = "";
            public string verticalScope { get; set; } = "room+plenum"; // room | plenum | room+plenum
            public string roomMode { get; set; } = "auto"; // auto | roomAware | geometry
        }

        public sealed class Params
        {
            public ScopeSpec? scope { get; set; }
            public string? systemClassification { get; set; }
            public string? sizeFrom { get; set; }
            public string sizeTo { get; set; } = "";
            public bool includeFittings { get; set; } = true;
            public bool includeTerminals { get; set; } = true;
            public string resolveTypeDriven { get; set; } = "duplicate"; // auto | duplicate | skip
            public bool repairContinuity { get; set; } = false;
            public double continuityMaxGapFt { get; set; } = 1.5;
            public int continuityMaxRepairs { get; set; } = 8;
            public bool verify { get; set; } = true;
            public bool dryRun { get; set; } = true;
            public string? confirm { get; set; }
            public int? maxElements { get; set; } = 5000;
        }

        private sealed class ChangeRow
        {
            public long elementId { get; set; }
            public string category { get; set; } = "";
            public string oldSize { get; set; } = "";
            public string newSize { get; set; } = "";
            public string typeChanges { get; set; } = "";
            public string system { get; set; } = "";
        }

        private sealed class PostConditionResult
        {
            public int targetedCount { get; set; }
            public int matchedTargetCount { get; set; }
            public int unresolvedCount { get; set; }
            public List<object> unresolved { get; set; } = new List<object>();
        }

        internal sealed class OpenConnectorInfo
        {
            public long ownerId { get; set; }
            public string ownerCategory { get; set; } = "";
            public string? systemName { get; set; }
            public string? systemClassification { get; set; }
            public Connector connector { get; set; } = null!;
            public XYZ origin { get; set; } = XYZ.Zero;
            public XYZ direction { get; set; } = XYZ.Zero;
            public ConnectorProfileType shape { get; set; }
            public double? diameterFt { get; set; }
            public double? widthFt { get; set; }
            public double? heightFt { get; set; }
        }

        internal sealed class ContinuityRepairResult
        {
            public bool requested { get; set; }
            public bool dryRun { get; set; }
            public bool transactionGroupRolledBack { get; set; }
            public bool transactionRolledBack { get; set; }
            public bool rollbackVerified { get; set; }
            public int attempts { get; set; }
            public int repairedCount { get; set; }
            public List<long> createdSegmentIds { get; set; } = new List<long>();
            public bool createdSegmentIdsAreTransient { get; set; }
            public List<string> beforeConnectorFingerprint { get; set; } = new List<string>();
            public List<string> afterConnectorFingerprint { get; set; } = new List<string>();
            public List<string> finalConnectorFingerprint { get; set; } = new List<string>();
            public List<object> details { get; set; } = new List<object>();
            public List<CapturedFailure> nativeFailures { get; set; } = new List<CapturedFailure>();
        }

        internal sealed class ContinuityAuditResult
        {
            public bool ok { get; set; }
            public int openConnectorCount { get; set; }
            public List<object> openConnectors { get; set; } = new List<object>();
            public int disconnectedTouchedCount { get; set; }
            public List<long> disconnectedTouchedIds { get; set; } = new List<long>();
            public int auditedSystemsCount { get; set; }
            public List<object> systemAudits { get; set; } = new List<object>();
            public List<object> likelyMissingSegments { get; set; } = new List<object>();
        }

        internal sealed class CreatedSegmentAudit
        {
            public int createdCount { get; set; }
            public int isolatedCount { get; set; }
            public int systemMismatchCount { get; set; }
            public List<long> isolatedIds { get; set; } = new List<long>();
            public List<long> systemMismatchIds { get; set; } = new List<long>();
            public List<object> details { get; set; } = new List<object>();
        }

        public Task<object> Handle(UIApplication app, string jsonData)
        {
            var p = string.IsNullOrWhiteSpace(jsonData) ? new Params() : (JsonSerializer.Deserialize<Params>(jsonData) ?? new Params());
            if (p.scope == null) throw new ArgumentException("scope is required.");

            var roomNumber = (p.scope.roomNumber ?? "").Trim();
            if (roomNumber.Length == 0) throw new ArgumentException("scope.roomNumber is required.");
            var sizeToText = (p.sizeTo ?? "").Trim();
            if (sizeToText.Length == 0) throw new ArgumentException("sizeTo is required.");

            var uidoc = app.ActiveUIDocument;
            if (uidoc == null) throw new InvalidOperationException("No active UI document.");
            var doc = uidoc.Document;

            if (!LengthTextUtil.TryParseLengthToFeet(doc, sizeToText, out var targetSizeFt, out var targetErr) || targetSizeFt <= 0)
                throw new InvalidOperationException($"Could not parse sizeTo: {targetErr}");

            var resolveTypeDriven = (p.resolveTypeDriven ?? "duplicate").Trim();
            if (resolveTypeDriven.Length == 0) resolveTypeDriven = "duplicate";
            if (!resolveTypeDriven.Equals("auto", StringComparison.OrdinalIgnoreCase) &&
                !resolveTypeDriven.Equals("duplicate", StringComparison.OrdinalIgnoreCase) &&
                !resolveTypeDriven.Equals("skip", StringComparison.OrdinalIgnoreCase))
            {
                throw new ArgumentException("resolveTypeDriven must be one of: auto | duplicate | skip.");
            }

            var includeCategories = new List<string> { "Ducts" };
            if (p.includeFittings) includeCategories.Add("Duct Fittings");
            if (p.includeTerminals) includeCategories.Add("Air Terminals");
            var warnings = new List<string>();

            var scopeReq = new DuctsBySpatialScopeHandler.Params
            {
                roomNumber = roomNumber,
                roomMode = p.scope.roomMode,
                verticalScope = p.scope.verticalScope,
                includeCategories = includeCategories,
                systemClassification = p.systemClassification,
                sizeFrom = p.sizeFrom,
                limit = p.maxElements
            };

            object? classificationFallback = null;
            var scopedResult = new DuctsBySpatialScopeHandler().Handle(app, JsonSerializer.Serialize(scopeReq)).GetAwaiter().GetResult();
            var scopedIds = ReadIdList(scopedResult, "elementIds");
            var requestedSystem = (p.systemClassification ?? "").Trim();
            if (scopedIds.Count == 0 && !MepSystemUtil.IsAnySystemClassification(requestedSystem))
            {
                var anyReq = new DuctsBySpatialScopeHandler.Params
                {
                    roomNumber = roomNumber,
                    roomMode = p.scope.roomMode,
                    verticalScope = p.scope.verticalScope,
                    includeCategories = includeCategories,
                    systemClassification = "Any",
                    sizeFrom = p.sizeFrom,
                    limit = p.maxElements
                };

                var anyScopeResult = new DuctsBySpatialScopeHandler().Handle(app, JsonSerializer.Serialize(anyReq)).GetAwaiter().GetResult();
                var anyIds = ReadIdList(anyScopeResult, "elementIds");
                var filteredFallbackIds = new List<long>();
                foreach (var id in anyIds)
                {
                    var e = doc.GetElement(RevitBridge.Common.ElementIdCompat.Create(id));
                    if (e == null) continue;
                    if (!MepSystemUtil.ElementMatchesSystemClassification(e, requestedSystem)) continue;
                    filteredFallbackIds.Add(id);
                }

                if (filteredFallbackIds.Count > 0)
                {
                    scopedIds = filteredFallbackIds.Distinct().ToList();
                    warnings.Add($"Scoped lookup fell back from systemClassification='{requestedSystem}' to Any + tolerant classification matching.");
                }

                classificationFallback = new
                {
                    requestedSystemClassification = requestedSystem,
                    used = filteredFallbackIds.Count > 0,
                    anyScopedCount = anyIds.Count,
                    filteredCount = filteredFallbackIds.Count,
                    anyScopeResult
                };
            }

            if (scopedIds.Count == 0)
            {
                return Task.FromResult<object>(new
                {
                    status = "Ok",
                    endpoint = "/revit/resize-ductwork-by-scope",
                    dryRun = p.dryRun,
                    scope = p.scope,
                    systemClassification = p.systemClassification,
                    sizeFrom = p.sizeFrom,
                    sizeTo = p.sizeTo,
                    matchedCount = 0,
                    scopeResult = scopedResult,
                    classificationFallback,
                    warnings
                });
            }

            var ductIds = new List<long>();
            foreach (var id in scopedIds)
            {
                var e = doc.GetElement(RevitBridge.Common.ElementIdCompat.Create(id));
                if (e == null) continue;
                if (RevitBridge.Common.ElementIdCompat.GetValue(e.Category?.Id) == (int)BuiltInCategory.OST_DuctCurves) ductIds.Add(id);
            }
            ductIds = ductIds.Distinct().ToList();

            var changeRows = new List<ChangeRow>();
            var ductChanges = new List<object>();
            var ductChangedCount = 0;

            if (!p.dryRun)
            {
                using (var t = new Transaction(doc, "Resize Ductwork By Scope"))
                {
                    t.Start();
                    WarningSuppressionUtil.SuppressWarnings(t);

                    foreach (var id in ductIds)
                    {
                        var e = doc.GetElement(RevitBridge.Common.ElementIdCompat.Create(id));
                        if (e == null) continue;

                        var pDia = GetRoundDiameterParam(e);
                        if (pDia == null || pDia.IsReadOnly) continue;

                        var oldValue = pDia.AsValueString() ?? pDia.AsString() ?? "";
                        var changed = false;
                        if (pDia.StorageType == StorageType.Double)
                        {
                            var cur = pDia.AsDouble();
                            if (Math.Abs(cur - targetSizeFt) > 1e-9)
                            {
                                pDia.Set(targetSizeFt);
                                changed = true;
                            }
                        }
                        else
                        {
                            ParameterValueUtil.TrySetFromString(pDia, LengthTextUtil.FormatLength(doc, targetSizeFt), out changed, out _);
                        }

                        var newValue = pDia.AsValueString() ?? pDia.AsString() ?? LengthTextUtil.FormatLength(doc, targetSizeFt);
                        ductChanges.Add(new { id, changed, oldSize = oldValue, newSize = newValue });

                        if (changed)
                        {
                            ductChangedCount++;
                            changeRows.Add(new ChangeRow
                            {
                                elementId = id,
                                category = SelectionUtil.GetCategoryToken(e) ?? "",
                                oldSize = oldValue,
                                newSize = newValue,
                                typeChanges = "instance",
                                system = MepSystemUtil.TryGetSystemName(e) ?? ""
                            });
                        }
                    }

                    t.Commit();
                }

                try { doc.Regenerate(); } catch { }
                try { uidoc.RefreshActiveView(); } catch { }
            }

            object? syncResult = null;
            var syncPasses = new List<object>();
            if (p.includeFittings || p.includeTerminals)
            {
                var maxSyncPasses = p.dryRun ? 1 : 3;
                var lastSyncChangedCount = 0;
                object? lastPassResult = null;
                for (var pass = 1; pass <= maxSyncPasses; pass++)
                {
                    var syncReq = new SyncConnectedSizesHandler.Params
                    {
                        elementIds = scopedIds,
                        dryRun = p.dryRun,
                        maxElements = p.maxElements ?? 5000,
                        resolveTypeDriven = resolveTypeDriven,
                        confirm = p.confirm
                    };

                    var passResult = new SyncConnectedSizesHandler().Handle(app, JsonSerializer.Serialize(syncReq)).GetAwaiter().GetResult();
                    lastPassResult = passResult;
                    syncPasses.Add(new
                    {
                        pass,
                        changedCount = ReadSyncChangedCount(passResult),
                        result = passResult
                    });

                    foreach (var row in ReadSyncChangeRows(passResult))
                    {
                        if (!changeRows.Any(x => x.elementId == row.elementId)) changeRows.Add(row);
                    }

                    var changedThisPass = ReadSyncChangedCount(passResult);
                    lastSyncChangedCount = changedThisPass;
                    if (p.dryRun || changedThisPass <= 0) break;
                }

                syncResult = syncPasses.Count <= 1
                    ? lastPassResult
                    : new
                    {
                        converged = lastSyncChangedCount <= 0,
                        passes = syncPasses
                    };
            }

            var continuityMaxGapFt = p.continuityMaxGapFt > 0 ? p.continuityMaxGapFt : 1.5;
            var continuityMaxRepairs = p.continuityMaxRepairs <= 0 ? 0 : Math.Min(p.continuityMaxRepairs, 64);
            var continuityScopeIds = changeRows.Select(x => x.elementId).Where(x => x > 0).Distinct().ToList();
            if (continuityScopeIds.Count == 0) continuityScopeIds = scopedIds;
            var continuityRepair = new ContinuityRepairResult
            {
                requested = p.repairContinuity,
                dryRun = p.dryRun,
                attempts = 0,
                repairedCount = 0
            };

            if (p.dryRun && p.repairContinuity && continuityMaxRepairs > 0 && continuityScopeIds.Count > 0)
            {
                continuityRepair = DryRunContinuityRepair(
                    doc,
                    continuityScopeIds,
                    targetSizeFt,
                    continuityMaxGapFt,
                    continuityMaxRepairs,
                    warnings);
            }
            else if (!p.dryRun && p.repairContinuity && continuityMaxRepairs > 0 && continuityScopeIds.Count > 0)
            {
                continuityRepair = ApplyContinuityRepair(
                    doc,
                    continuityScopeIds,
                    targetSizeFt,
                    continuityMaxGapFt,
                    continuityMaxRepairs,
                    warnings);

                if (continuityRepair.repairedCount > 0 && (p.includeFittings || p.includeTerminals))
                {
                    try
                    {
                        var syncReq = new SyncConnectedSizesHandler.Params
                        {
                            elementIds = scopedIds,
                            dryRun = false,
                            maxElements = p.maxElements ?? 5000,
                            resolveTypeDriven = resolveTypeDriven,
                            confirm = p.confirm
                        };

                        var postRepairSync = new SyncConnectedSizesHandler().Handle(app, JsonSerializer.Serialize(syncReq)).GetAwaiter().GetResult();
                        syncPasses.Add(new
                        {
                            pass = syncPasses.Count + 1,
                            phase = "postRepair",
                            changedCount = ReadSyncChangedCount(postRepairSync),
                            result = postRepairSync
                        });

                        foreach (var row in ReadSyncChangeRows(postRepairSync))
                        {
                            if (!changeRows.Any(x => x.elementId == row.elementId)) changeRows.Add(row);
                        }

                        syncResult = syncPasses.Count <= 1
                            ? postRepairSync
                            : new
                            {
                                converged = ReadSyncChangedCount(postRepairSync) <= 0,
                                passes = syncPasses
                            };
                    }
                    catch (Exception ex)
                    {
                        warnings.Add($"post-repair sync-connected-sizes failed: {ex.Message}");
                    }
                }
            }

            var continuityAudit = EvaluateContinuity(
                app,
                doc,
                continuityScopeIds,
                p.systemClassification,
                Math.Min(p.maxElements ?? 5000, 20000),
                continuityMaxGapFt,
                warnings);

            var createdSegmentAudit = AuditCreatedRepairSegments(
                doc,
                continuityRepair.createdSegmentIds,
                continuityScopeIds);

            var postCondition = EvaluatePostCondition(
                doc,
                scopedIds,
                targetSizeFt,
                p.includeFittings,
                p.includeTerminals,
                p.systemClassification);

            var requiresSizePostCondition = !p.dryRun && ductChangedCount > 0 && (p.includeFittings || p.includeTerminals);
            var sizePostConditionOk = !requiresSizePostCondition || postCondition.unresolvedCount == 0;
            if (!sizePostConditionOk)
            {
                warnings.Add($"Post-condition failed: {postCondition.unresolvedCount} fitting/terminal elements are not at target size.");
            }

            var requiresContinuityPostCondition = !p.dryRun && p.repairContinuity;
            var continuityPostConditionOk = !requiresContinuityPostCondition || (continuityAudit.ok && createdSegmentAudit.isolatedCount == 0 && createdSegmentAudit.systemMismatchCount == 0);
            if (!continuityPostConditionOk)
            {
                warnings.Add($"Continuity post-condition failed: openConnectors={continuityAudit.openConnectorCount}, disconnectedTouched={continuityAudit.disconnectedTouchedCount}, isolatedCreated={createdSegmentAudit.isolatedCount}, systemMismatchCreated={createdSegmentAudit.systemMismatchCount}.");
            }

            var postConditionOk = sizePostConditionOk && continuityPostConditionOk;

            object? verifyResult = null;
            if (p.verify && scopedIds.Count > 0)
            {
                try
                {
                    var highlightReq = new HighlightAndExportHandler.Params
                    {
                        viewId = RevitBridge.Common.ElementIdCompat.GetValue(uidoc.ActiveView?.Id),
                        elementIds = scopedIds.Take(300).ToList()
                    };
                    verifyResult = new HighlightAndExportHandler().Handle(app, JsonSerializer.Serialize(highlightReq)).GetAwaiter().GetResult();
                }
                catch (Exception ex)
                {
                    warnings.Add($"verify capture failed: {ex.Message}");
                }
            }

            var artifacts = WriteArtifacts(changeRows);
            var finalStatus = p.dryRun ? "Dry Run" : (postConditionOk ? "Applied" : "Partial");

            return Task.FromResult<object>(new
            {
                status = finalStatus,
                endpoint = "/revit/resize-ductwork-by-scope",
                dryRun = p.dryRun,
                scope = p.scope,
                systemClassification = p.systemClassification,
                sizeFrom = p.sizeFrom,
                sizeTo = p.sizeTo,
                includeFittings = p.includeFittings,
                includeTerminals = p.includeTerminals,
                resolveTypeDriven,
                repairContinuity = p.repairContinuity,
                continuityMaxGapFt,
                continuityMaxRepairs,
                counts = new
                {
                    scopedCount = scopedIds.Count,
                    ductsTargeted = ductIds.Count,
                    resizedCount = changeRows.Count,
                    ductChangedCount,
                    postConditionUnresolved = postCondition.unresolvedCount,
                    continuityOpenConnectors = continuityAudit.openConnectorCount,
                    continuityDisconnectedTouched = continuityAudit.disconnectedTouchedCount,
                    continuityRepairedCount = continuityRepair.repairedCount,
                    continuityIsolatedCreated = createdSegmentAudit.isolatedCount,
                    continuitySystemMismatchCreated = createdSegmentAudit.systemMismatchCount
                },
                scopeResult = scopedResult,
                classificationFallback,
                ductChanges,
                syncResult,
                syncPasses,
                continuityRepair,
                continuityAudit,
                createdSegmentAudit,
                resizedElements = changeRows,
                postCondition = new
                {
                    required = requiresSizePostCondition || requiresContinuityPostCondition,
                    ok = postConditionOk,
                    sizeRequired = requiresSizePostCondition,
                    sizeOk = sizePostConditionOk,
                    continuityRequired = requiresContinuityPostCondition,
                    continuityOk = continuityPostConditionOk,
                    targetSize = LengthTextUtil.FormatLength(doc, targetSizeFt),
                    targetSizeFt,
                    targetedCount = postCondition.targetedCount,
                    matchedTargetCount = postCondition.matchedTargetCount,
                    unresolvedCount = postCondition.unresolvedCount,
                    unresolved = postCondition.unresolved,
                    continuity = new
                    {
                        openConnectorCount = continuityAudit.openConnectorCount,
                        disconnectedTouchedCount = continuityAudit.disconnectedTouchedCount,
                        disconnectedTouchedIds = continuityAudit.disconnectedTouchedIds,
                        isolatedCreatedCount = createdSegmentAudit.isolatedCount,
                        isolatedCreatedIds = createdSegmentAudit.isolatedIds,
                        systemMismatchCreatedCount = createdSegmentAudit.systemMismatchCount,
                        systemMismatchCreatedIds = createdSegmentAudit.systemMismatchIds
                    }
                },
                verify = verifyResult,
                artifact = artifacts,
                warnings
            });
        }

        private static List<long> ReadIdList(object payload, string key)
        {
            var outList = new List<long>();
            try
            {
                using var doc = JsonDocument.Parse(JsonSerializer.Serialize(payload));
                if (!doc.RootElement.TryGetProperty(key, out var arr) || arr.ValueKind != JsonValueKind.Array) return outList;
                foreach (var idEl in arr.EnumerateArray())
                {
                    if (idEl.ValueKind == JsonValueKind.Number && idEl.TryGetInt64(out var id) && id > 0) outList.Add(id);
                }
            }
            catch
            {
                // ignore
            }
            return outList;
        }

        private static List<ChangeRow> ReadSyncChangeRows(object? syncResult)
        {
            var outRows = new List<ChangeRow>();
            if (syncResult == null) return outRows;

            try
            {
                using var doc = JsonDocument.Parse(JsonSerializer.Serialize(syncResult));
                if (!doc.RootElement.TryGetProperty("changes", out var changes) || changes.ValueKind != JsonValueKind.Array) return outRows;
                foreach (var c in changes.EnumerateArray())
                {
                    if (!c.TryGetProperty("id", out var idEl) || idEl.ValueKind != JsonValueKind.Number || !idEl.TryGetInt64(out var id)) continue;
                    var changed = c.TryGetProperty("changed", out var ch) && ch.ValueKind == JsonValueKind.True;
                    if (!changed) continue;

                    var category = c.TryGetProperty("category", out var cat) && cat.ValueKind == JsonValueKind.String ? (cat.GetString() ?? "") : "";
                    var system = c.TryGetProperty("systemName", out var sys) && sys.ValueKind == JsonValueKind.String ? (sys.GetString() ?? "") : "";
                    var newSize = "";
                    if (c.TryGetProperty("desired", out var desired) && desired.ValueKind == JsonValueKind.Object)
                    {
                        if (desired.TryGetProperty("diameter", out var d) && d.ValueKind == JsonValueKind.String)
                        {
                            newSize = d.GetString() ?? "";
                        }
                        else if (desired.TryGetProperty("width", out var w) &&
                                 desired.TryGetProperty("height", out var h) &&
                                 w.ValueKind == JsonValueKind.String &&
                                 h.ValueKind == JsonValueKind.String)
                        {
                            newSize = (w.GetString() ?? "") + " x " + (h.GetString() ?? "");
                        }
                    }

                    outRows.Add(new ChangeRow
                    {
                        elementId = id,
                        category = category,
                        oldSize = "",
                        newSize = newSize,
                        typeChanges = "sync-instance",
                        system = system
                    });
                }
            }
            catch
            {
                // ignore
            }

            return outRows;
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

        internal static ContinuityAuditResult EvaluateContinuity(
            UIApplication app,
            Document doc,
            IEnumerable<long> scopedIds,
            string? systemClassification,
            int maxElements,
            double likelyGapFt,
            List<string> warnings)
        {
            var result = new ContinuityAuditResult();
            if (doc == null) return result;

            var touchedIds = new HashSet<long>();
            foreach (var id in scopedIds ?? Enumerable.Empty<long>())
            {
                if (id <= 0) continue;
                var e = doc.GetElement(RevitBridge.Common.ElementIdCompat.Create(id));
                if (e == null) continue;
                if (!IsContinuityAuditElement(e, includeTerminals: true)) continue;
                if (!MepSystemUtil.ElementMatchesSystemClassification(e, systemClassification)) continue;
                touchedIds.Add(id);
            }

            if (touchedIds.Count == 0)
            {
                result.ok = true;
                return result;
            }

            var open = CollectOpenConnectors(doc, touchedIds, includeTerminals: false);
            result.openConnectorCount = open.Count;
            result.openConnectors = open
                .Take(200)
                .Select(x => (object)new
                {
                    ownerId = x.ownerId,
                    ownerCategory = x.ownerCategory,
                    systemName = x.systemName,
                    shape = x.shape.ToString(),
                    size = FormatConnectorSize(doc, x),
                    origin = new[] { x.origin.X, x.origin.Y, x.origin.Z }
                })
                .ToList();

            result.likelyMissingSegments = FindLikelyMissingSegments(doc, open, likelyGapFt)
                .Take(25)
                .ToList();

            var touchedIdSet = new HashSet<long>(touchedIds);
            var systemGroups = touchedIds
                .Select(id => doc.GetElement(RevitBridge.Common.ElementIdCompat.Create(id)))
                .Where(e => e != null)
                .Select(e => new { id = RevitBridge.Common.ElementIdCompat.GetValue(e!.Id), system = MepSystemUtil.TryGetSystemName(e) })
                .Where(x => !string.IsNullOrWhiteSpace(x.system))
                .GroupBy(x => x.system!, StringComparer.OrdinalIgnoreCase)
                .Take(16)
                .ToList();

            var disconnectedUnion = new HashSet<long>();
            foreach (var g in systemGroups)
            {
                var seedId = g.Select(x => x.id).FirstOrDefault(x => x > 0);
                if (seedId <= 0) continue;

                try
                {
                    var traceReq = new TraceConnectedNetworkHandler.Params
                    {
                        startElementId = seedId,
                        systemName = g.Key,
                        inferSystemFromStart = false,
                        stopAtBranchFittings = false,
                        stopAtTransitions = false,
                        includeDucts = true,
                        includeFittings = true,
                        includeAccessories = true,
                        includeTerminals = true,
                        includeEquipment = true,
                        includeOtherCategories = false,
                        maxElements = Math.Min(Math.Max(maxElements, 1000), 50000),
                        includeSystemAudit = true,
                        systemAuditMaxElements = Math.Min(Math.Max(maxElements * 2, 5000), 100000)
                    };

                    var traceResult = new TraceConnectedNetworkHandler().Handle(app, JsonSerializer.Serialize(traceReq)).GetAwaiter().GetResult();
                    var disconnected = ReadSystemAuditDisconnectedIds(traceResult);
                    var disconnectedTouched = disconnected
                        .Where(touchedIdSet.Contains)
                        .Distinct()
                        .OrderBy(x => x)
                        .ToList();

                    foreach (var id in disconnectedTouched) disconnectedUnion.Add(id);

                    result.systemAudits.Add(new
                    {
                        systemName = g.Key,
                        seedId,
                        disconnectedTouchedCount = disconnectedTouched.Count,
                        disconnectedTouchedIds = disconnectedTouched.Take(200).ToList()
                    });
                }
                catch (Exception ex)
                {
                    warnings.Add($"continuity trace failed for system '{g.Key}': {ex.Message}");
                }
            }

            result.disconnectedTouchedIds = disconnectedUnion.OrderBy(x => x).Take(1000).ToList();
            result.disconnectedTouchedCount = result.disconnectedTouchedIds.Count;
            result.auditedSystemsCount = result.systemAudits.Count;
            result.ok = result.openConnectorCount == 0 && result.disconnectedTouchedCount == 0;
            return result;
        }

        internal static ContinuityRepairResult ApplyContinuityRepair(
            Document doc,
            IEnumerable<long> scopedIds,
            double targetSizeFt,
            double maxGapFt,
            int maxRepairs,
            List<string> warnings)
        {
            var result = new ContinuityRepairResult
            {
                requested = true
            };
            if (doc == null || maxRepairs <= 0) return result;

            var touchedIds = new HashSet<long>((scopedIds ?? Enumerable.Empty<long>()).Where(x => x > 0));
            if (touchedIds.Count == 0) return result;

            var blockedPairKeys = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            using (var t = new Transaction(doc, "Repair Duct Continuity"))
            {
                t.Start();
                t.SetFailureHandlingOptions(FailureHandlingUtil.ConfigureFailureCapture(
                    t,
                    result.nativeFailures,
                    rollbackOnErrors: true,
                    deleteWarnings: false));

                try
                {
                    RunContinuityRepairAttempts(
                        doc,
                        touchedIds,
                        targetSizeFt,
                        maxGapFt,
                        maxRepairs,
                        blockedPairKeys,
                        result);

                    if (result.repairedCount > 0)
                    {
                        var status = t.Commit();
                        if (status != TransactionStatus.Committed)
                            warnings.Add($"continuity repair transaction was not committed: {status}");
                    }
                    else
                    {
                        t.RollBack();
                    }
                }
                catch (Exception ex)
                {
                    try { t.RollBack(); } catch { }
                    warnings.Add($"continuity repair failed: {ex.Message}");
                }
            }

            return result;
        }

        internal static ContinuityRepairResult DryRunContinuityRepair(
            Document doc,
            IEnumerable<long> scopedIds,
            double targetSizeFt,
            double maxGapFt,
            int maxRepairs,
            List<string> warnings)
        {
            var ids = (scopedIds ?? Enumerable.Empty<long>())
                .Where(id => id > 0)
                .Distinct()
                .OrderBy(id => id)
                .ToList();
            var before = SnapshotContinuityConnectorFingerprint(doc, ids);
            var result = new ContinuityRepairResult
            {
                requested = true,
                dryRun = true,
                beforeConnectorFingerprint = before
            };
            using (var transaction = new Transaction(doc, "Dry Run Duct Continuity Repair"))
            {
                transaction.Start();
                transaction.SetFailureHandlingOptions(FailureHandlingUtil.ConfigureFailureCapture(
                    transaction,
                    result.nativeFailures,
                    rollbackOnErrors: true,
                    deleteWarnings: false));
                try
                {
                    RunContinuityRepairAttempts(
                        doc,
                        new HashSet<long>(ids),
                        targetSizeFt,
                        maxGapFt,
                        maxRepairs,
                        new HashSet<string>(StringComparer.OrdinalIgnoreCase),
                        result);
                    result.afterConnectorFingerprint = SnapshotContinuityConnectorFingerprint(doc, ids);
                    result.createdSegmentIdsAreTransient = result.createdSegmentIds.Count > 0;
                    transaction.RollBack();
                    result.transactionRolledBack = true;
                }
                catch (Exception ex)
                {
                    try
                    {
                        if (transaction.GetStatus() == TransactionStatus.Started)
                        {
                            transaction.RollBack();
                            result.transactionRolledBack = true;
                        }
                    }
                    catch { }
                    warnings.Add($"continuity dry-run failed: {ex.Message}");
                }
            }
            result.finalConnectorFingerprint = SnapshotContinuityConnectorFingerprint(doc, ids);
            result.rollbackVerified = result.transactionRolledBack &&
                result.beforeConnectorFingerprint.SequenceEqual(result.finalConnectorFingerprint);
            if (!result.rollbackVerified)
                warnings.Add("continuity dry-run rollback did not restore the exact connector fingerprint.");
            return result;
        }

        private static void RunContinuityRepairAttempts(
            Document doc,
            HashSet<long> touchedIds,
            double targetSizeFt,
            double maxGapFt,
            int maxRepairs,
            HashSet<string> blockedPairKeys,
            ContinuityRepairResult result)
        {
            for (var attempt = 1; attempt <= maxRepairs; attempt++)
            {
                var open = CollectOpenConnectors(doc, touchedIds, includeTerminals: false)
                    .Where(x => IsSupportedDuctConnectorShape(x.shape))
                    .ToList();
                if (open.Count < 2) break;

                var pair = FindBestRepairPair(open, maxGapFt, blockedPairKeys, out var pairKey, out var distanceFt);
                if (pair == null || pairKey == null) break;

                result.attempts++;
                var repaired = TryRepairConnectorPair(
                    doc,
                    pair.Item1,
                    pair.Item2,
                    targetSizeFt,
                    out var createdSegmentIds,
                    out var mode,
                    out var detailMessage);

                if (repaired)
                {
                    result.repairedCount++;
                    result.createdSegmentIds.AddRange(createdSegmentIds.Where(id => id > 0));
                }
                else
                {
                    blockedPairKeys.Add(pairKey);
                }

                result.details.Add(new
                {
                    attempt,
                    repaired,
                    mode,
                    distanceFt,
                    fromElementId = pair.Item1.ownerId,
                    toElementId = pair.Item2.ownerId,
                    createdSegmentIds,
                    message = detailMessage
                });

                try { doc.Regenerate(); } catch { }
            }
        }

        private static List<string> SnapshotContinuityConnectorFingerprint(
            Document doc,
            IEnumerable<long> elementIds)
        {
            var result = new List<string>();
            foreach (var elementId in (elementIds ?? Enumerable.Empty<long>())
                .Where(id => id > 0)
                .Distinct()
                .OrderBy(id => id))
            {
                var element = doc.GetElement(ElementIdCompat.Create(elementId));
                if (element == null)
                {
                    result.Add($"{elementId}|missing");
                    continue;
                }
                foreach (var connector in MepSystemUtil.GetConnectors(element))
                {
                    if (connector == null) continue;
                    var connectorId = MepSystemUtil.TryGetNativeConnectorId(connector, out var nativeId)
                        ? $"native:{nativeId}"
                        : $"origin:{PointFingerprint(connector.Origin)}";
                    var owners = new HashSet<long>();
                    try
                    {
                        foreach (Connector reference in connector.AllRefs)
                        {
                            var owner = reference?.Owner;
                            if (owner == null || owner is MEPSystem || owner.Id == connector.Owner?.Id) continue;
                            owners.Add(ElementIdCompat.GetValue(owner.Id));
                        }
                    }
                    catch { }
                    result.Add(
                        $"{elementId}/{connectorId}@{PointFingerprint(connector.Origin)}=>" +
                        string.Join(",", owners.OrderBy(id => id)));
                }
            }
            return result.OrderBy(value => value, StringComparer.Ordinal).ToList();
        }

        private static Tuple<OpenConnectorInfo, OpenConnectorInfo>? FindBestRepairPair(
            List<OpenConnectorInfo> open,
            double maxGapFt,
            HashSet<string> blockedPairKeys,
            out string? pairKey,
            out double distanceFt)
        {
            pairKey = null;
            distanceFt = double.MaxValue;
            if (open == null || open.Count < 2) return null;

            Tuple<OpenConnectorInfo, OpenConnectorInfo>? best = null;
            var sizeTolFt = 1.0 / 12.0; // 1 inch
            var gapFt = maxGapFt > 0 ? maxGapFt : 1.5;

            for (var i = 0; i < open.Count - 1; i++)
            {
                var a = open[i];
                for (var j = i + 1; j < open.Count; j++)
                {
                    var b = open[j];
                    if (a.ownerId == b.ownerId) continue;
                    if (!AreConnectorProfilesCompatible(a, b, sizeTolFt)) continue;

                    var thisKey = BuildConnectorPairKey(a, b);
                    if (blockedPairKeys.Contains(thisKey)) continue;

                    if (!AreDuctSystemsCompatible(a, b)) continue;

                    var d = a.origin.DistanceTo(b.origin);
                    if (d <= 1e-6 || d > gapFt) continue;
                    if (ClassifyRepairRoute(a, b, out _) == ContinuityRouteKind.None) continue;
                    if (d >= distanceFt) continue;

                    distanceFt = d;
                    pairKey = thisKey;
                    best = Tuple.Create(a, b);
                }
            }

            return best;
        }

        private static bool TryRepairConnectorPair(
            Document doc,
            OpenConnectorInfo a,
            OpenConnectorInfo b,
            double targetSizeFt,
            out List<long> createdSegmentIds,
            out string mode,
            out string detail)
        {
            createdSegmentIds = new List<long>();
            mode = "none";
            detail = "";
            if (doc == null) return false;

            using (var st = new SubTransaction(doc))
            {
                st.Start();
                try
                {
                    var dist = a.origin.DistanceTo(b.origin);
                    if (dist <= OpenConnectorMergeToleranceFt)
                    {
                        a.connector.ConnectTo(b.connector);
                        mode = "directConnect";
                        detail = "Connected nearby open connectors directly.";
                        st.Commit();
                        return true;
                    }

                    var routeKind = ClassifyRepairRoute(a, b, out var corner);
                    if (routeKind == ContinuityRouteKind.None)
                    {
                        detail = "Open connector directions do not define a source-safe facing or orthogonal route.";
                        st.RollBack();
                        return false;
                    }

                    var systemTypeId = ResolveSystemTypeId(doc, a, b);
                    var ductTypeId = ResolveDuctTypeId(doc, a, b);
                    var levelId = ResolveLevelId(doc, a, b);
                    if (systemTypeId == null || RevitBridge.Common.ElementIdCompat.GetValue(systemTypeId) <= 0)
                    {
                        detail = "Could not resolve duct system type.";
                        st.RollBack();
                        return false;
                    }
                    if (ductTypeId == null || RevitBridge.Common.ElementIdCompat.GetValue(ductTypeId) <= 0)
                    {
                        detail = "Could not resolve duct type.";
                        st.RollBack();
                        return false;
                    }
                    if (levelId == null || RevitBridge.Common.ElementIdCompat.GetValue(levelId) <= 0)
                    {
                        detail = "Could not resolve level.";
                        st.RollBack();
                        return false;
                    }

                    if (routeKind == ContinuityRouteKind.Direct)
                    {
                        var bridge = CreateProfiledBridge(
                            doc,
                            systemTypeId,
                            ductTypeId,
                            levelId,
                            a.origin,
                            b.origin,
                            a,
                            b,
                            targetSizeFt,
                            out var profileError);
                        if (bridge == null)
                        {
                            detail = profileError;
                            st.RollBack();
                            return false;
                        }

                        try { doc.Regenerate(); } catch { }
                        if (!TryResolveBridgeEnds(bridge, a.origin, b.origin, out var nearA, out var nearB))
                        {
                            detail = "Could not resolve bridge end connectors.";
                            st.RollBack();
                            return false;
                        }

                        nearA.ConnectTo(a.connector);
                        nearB.ConnectTo(b.connector);
                        createdSegmentIds.Add(ElementIdCompat.GetValue(bridge.Id));
                        mode = "bridgeSegment";
                        detail = "Inserted a direction-validated bridge duct between facing open connectors.";
                    }
                    else
                    {
                        var first = CreateProfiledBridge(
                            doc,
                            systemTypeId,
                            ductTypeId,
                            levelId,
                            a.origin,
                            corner,
                            a,
                            b,
                            targetSizeFt,
                            out var firstError);
                        if (first == null)
                        {
                            detail = firstError;
                            st.RollBack();
                            return false;
                        }
                        var second = CreateProfiledBridge(
                            doc,
                            systemTypeId,
                            ductTypeId,
                            levelId,
                            b.origin,
                            corner,
                            a,
                            b,
                            targetSizeFt,
                            out var secondError);
                        if (second == null)
                        {
                            detail = secondError;
                            st.RollBack();
                            return false;
                        }

                        try { doc.Regenerate(); } catch { }
                        if (!TryResolveBridgeEnds(first, a.origin, corner, out var firstOuter, out var firstCorner) ||
                            !TryResolveBridgeEnds(second, b.origin, corner, out var secondOuter, out var secondCorner))
                        {
                            detail = "Could not resolve orthogonal bridge connectors.";
                            st.RollBack();
                            return false;
                        }

                        firstOuter.ConnectTo(a.connector);
                        secondOuter.ConnectTo(b.connector);
                        var elbow = doc.Create.NewElbowFitting(firstCorner, secondCorner);
                        if (elbow == null)
                        {
                            detail = "Revit did not create the orthogonal bridge elbow.";
                            st.RollBack();
                            return false;
                        }

                        createdSegmentIds.Add(ElementIdCompat.GetValue(first.Id));
                        createdSegmentIds.Add(ElementIdCompat.GetValue(second.Id));
                        mode = "orthogonalBridge";
                        detail = "Inserted two profile-matched duct segments and a native elbow between orthogonal open connectors.";
                    }

                    st.Commit();
                    return true;
                }
                catch (Exception ex)
                {
                    try { st.RollBack(); } catch { }
                    detail = ex.Message;
                    return false;
                }
            }
        }

        private static List<OpenConnectorInfo> CollectOpenConnectors(Document doc, IEnumerable<long> elementIds, bool includeTerminals)
        {
            var outList = new List<OpenConnectorInfo>();
            if (doc == null) return outList;

            foreach (var id in elementIds ?? Enumerable.Empty<long>())
            {
                if (id <= 0) continue;
                var e = doc.GetElement(RevitBridge.Common.ElementIdCompat.Create(id));
                if (e == null) continue;
                if (!IsContinuityAuditElement(e, includeTerminals)) continue;

                try
                {
                    foreach (var c in MepSystemUtil.GetConnectors(e))
                    {
                        if (c == null) continue;
                        if (!IsConnectorOpen(e, c)) continue;

                        var info = new OpenConnectorInfo
                        {
                            ownerId = RevitBridge.Common.ElementIdCompat.GetValue(e.Id),
                            ownerCategory = SelectionUtil.GetCategoryToken(e) ?? (e.Category?.Name ?? ""),
                            systemName = MepSystemUtil.TryGetSystemName(e),
                            systemClassification = TryGetDuctSystemClassification(c),
                            connector = c,
                            origin = c.Origin,
                            direction = TryGetConnectorDirection(c),
                            shape = c.Shape
                        };

                        if (c.Shape == ConnectorProfileType.Round)
                        {
                            info.diameterFt = 2.0 * c.Radius;
                        }
                        else if (c.Shape == ConnectorProfileType.Rectangular ||
                                 c.Shape == ConnectorProfileType.Oval)
                        {
                            info.widthFt = c.Width;
                            info.heightFt = c.Height;
                        }

                        outList.Add(info);
                    }
                }
                catch
                {
                    // ignore per-element connector read failures
                }
            }

            return outList;
        }

        private static bool IsContinuityAuditElement(Element e, bool includeTerminals)
        {
            if (e == null) return false;
            var catId = RevitBridge.Common.ElementIdCompat.GetValue(e.Category?.Id);
            if (catId == (int)BuiltInCategory.OST_DuctCurves) return true;
            if (catId == (int)BuiltInCategory.OST_DuctFitting) return true;
            if (catId == (int)BuiltInCategory.OST_DuctAccessory) return true;
            if (includeTerminals && catId == (int)BuiltInCategory.OST_DuctTerminal) return true;
            return false;
        }

        private static bool IsConnectorOpen(Element owner, Connector c)
        {
            if (owner == null || c == null) return false;
            try
            {
                ConnectorSet? refs = null;
                try { refs = c.AllRefs; } catch { refs = null; }
                if (refs == null) return true;

                foreach (Connector r in refs)
                {
                    if (r == null) continue;
                    var other = r.Owner;
                    if (other == null) continue;
                    if (other.Id == null) continue;
                    if (RevitBridge.Common.ElementIdCompat.GetValue(other.Id) == RevitBridge.Common.ElementIdCompat.GetValue(owner.Id)) continue;
                    // Revit exposes logical HVAC-system membership through
                    // Connector.AllRefs as an MEPSystem owner. That reference
                    // is not a physical curve/fitting connection and must not
                    // hide an actually open duct connector from continuity
                    // repair.
                    if (other is MEPSystem) continue;
                    return false;
                }
            }
            catch
            {
                // treat read failures as unknown-open so audit can surface them
            }
            return true;
        }

        private static string BuildConnectorPairKey(OpenConnectorInfo a, OpenConnectorInfo b)
        {
            var ka = $"{a.ownerId}:{a.origin.X:F4}:{a.origin.Y:F4}:{a.origin.Z:F4}";
            var kb = $"{b.ownerId}:{b.origin.X:F4}:{b.origin.Y:F4}:{b.origin.Z:F4}";
            return string.CompareOrdinal(ka, kb) <= 0 ? $"{ka}|{kb}" : $"{kb}|{ka}";
        }

        private static string FormatConnectorSize(Document doc, OpenConnectorInfo c)
        {
            if (c.shape == ConnectorProfileType.Round && c.diameterFt.HasValue)
            {
                return LengthTextUtil.FormatLength(doc, c.diameterFt.Value);
            }
            if ((c.shape == ConnectorProfileType.Rectangular || c.shape == ConnectorProfileType.Oval) &&
                c.widthFt.HasValue && c.heightFt.HasValue)
            {
                return LengthTextUtil.FormatLength(doc, c.widthFt.Value) + " x " + LengthTextUtil.FormatLength(doc, c.heightFt.Value);
            }
            return c.shape.ToString();
        }

        private static List<object> FindLikelyMissingSegments(Document doc, List<OpenConnectorInfo> open, double maxGapFt)
        {
            var outList = new List<object>();
            if (doc == null || open == null || open.Count < 2) return outList;

            var cap = 50;
            var gap = maxGapFt > 0 ? Math.Max(maxGapFt, 0.5) : 1.5;
            var candidates = new List<(OpenConnectorInfo A, OpenConnectorInfo B, double D)>();
            for (var i = 0; i < open.Count - 1; i++)
            {
                var a = open[i];
                if (!IsSupportedDuctConnectorShape(a.shape)) continue;
                for (var j = i + 1; j < open.Count; j++)
                {
                    var b = open[j];
                    if (a.ownerId == b.ownerId) continue;
                    if (!AreConnectorProfilesCompatible(a, b, 1.0 / 12.0)) continue;
                    if (!AreDuctSystemsCompatible(a, b)) continue;

                    var d = a.origin.DistanceTo(b.origin);
                    if (d <= 1e-6 || d > gap) continue;
                    candidates.Add((a, b, d));
                }
            }

            foreach (var c in candidates.OrderBy(x => x.D).Take(cap))
            {
                outList.Add(new
                {
                    fromElementId = c.A.ownerId,
                    toElementId = c.B.ownerId,
                    distanceFt = c.D,
                    fromSize = FormatConnectorSize(doc, c.A),
                    toSize = FormatConnectorSize(doc, c.B),
                    reason = "NearbyOpenConnectors"
                });
            }
            return outList;
        }

        private static bool IsSupportedDuctConnectorShape(ConnectorProfileType shape)
        {
            return shape == ConnectorProfileType.Round ||
                   shape == ConnectorProfileType.Rectangular ||
                   shape == ConnectorProfileType.Oval;
        }

        private static bool AreDuctSystemsCompatible(OpenConnectorInfo a, OpenConnectorInfo b)
        {
            var classificationA = (a.systemClassification ?? "").Trim();
            var classificationB = (b.systemClassification ?? "").Trim();
            if (classificationA.Length > 0 && classificationB.Length > 0)
            {
                // Disconnected pieces of one intended run commonly acquire
                // different auto-generated MEP system instance names. The
                // stable safety boundary is the native duct classification.
                return string.Equals(classificationA, classificationB, StringComparison.OrdinalIgnoreCase);
            }

            if (!string.IsNullOrWhiteSpace(a.systemName) &&
                !string.IsNullOrWhiteSpace(b.systemName))
            {
                return MepSystemUtil.SystemNameMatches(a.systemName, b.systemName);
            }

            return true;
        }

        private static string? TryGetDuctSystemClassification(Connector connector)
        {
            if (connector == null) return null;
            try
            {
                var value = connector.DuctSystemType.ToString().Trim();
                if (value.Length == 0 ||
                    value.IndexOf("undefined", StringComparison.OrdinalIgnoreCase) >= 0 ||
                    value.IndexOf("invalid", StringComparison.OrdinalIgnoreCase) >= 0)
                {
                    return null;
                }
                return value;
            }
            catch
            {
                return null;
            }
        }

        private static string PointFingerprint(XYZ point)
        {
            return $"{BitConverter.DoubleToInt64Bits(point.X)}," +
                   $"{BitConverter.DoubleToInt64Bits(point.Y)}," +
                   $"{BitConverter.DoubleToInt64Bits(point.Z)}";
        }

        private static bool AreConnectorProfilesCompatible(OpenConnectorInfo a, OpenConnectorInfo b, double sizeToleranceFt)
        {
            if (a == null || b == null || a.shape != b.shape || !IsSupportedDuctConnectorShape(a.shape)) return false;

            var tolerance = sizeToleranceFt > 0 ? sizeToleranceFt : 1.0 / 12.0;
            if (a.shape == ConnectorProfileType.Round)
            {
                return !a.diameterFt.HasValue ||
                       !b.diameterFt.HasValue ||
                       Math.Abs(a.diameterFt.Value - b.diameterFt.Value) <= tolerance;
            }

            if (!a.widthFt.HasValue || !a.heightFt.HasValue ||
                !b.widthFt.HasValue || !b.heightFt.HasValue)
            {
                return true;
            }

            var sameOrientation =
                Math.Abs(a.widthFt.Value - b.widthFt.Value) <= tolerance &&
                Math.Abs(a.heightFt.Value - b.heightFt.Value) <= tolerance;
            var rotatedOrientation =
                Math.Abs(a.widthFt.Value - b.heightFt.Value) <= tolerance &&
                Math.Abs(a.heightFt.Value - b.widthFt.Value) <= tolerance;
            return sameOrientation || rotatedOrientation;
        }

        private static bool ApplyBridgeProfile(
            Duct bridge,
            OpenConnectorInfo a,
            OpenConnectorInfo b,
            double fallbackRoundSizeFt,
            out string error)
        {
            error = "";
            if (bridge == null)
            {
                error = "Bridge duct is null.";
                return false;
            }

            if (a.shape != b.shape)
            {
                error = $"Connector shape mismatch: {a.shape} vs {b.shape}.";
                return false;
            }

            if (a.shape == ConnectorProfileType.Round)
            {
                var desiredDiameter = a.diameterFt ?? b.diameterFt ?? fallbackRoundSizeFt;
                var pDia = bridge.get_Parameter(BuiltInParameter.RBS_CURVE_DIAMETER_PARAM);
                if (pDia == null || pDia.IsReadOnly || pDia.StorageType != StorageType.Double || desiredDiameter <= 0)
                {
                    error = "Could not set round bridge diameter.";
                    return false;
                }
                pDia.Set(desiredDiameter);
                return true;
            }

            if (a.shape == ConnectorProfileType.Rectangular || a.shape == ConnectorProfileType.Oval)
            {
                var desiredWidth = a.widthFt ?? b.widthFt;
                var desiredHeight = a.heightFt ?? b.heightFt;
                if (!desiredWidth.HasValue || !desiredHeight.HasValue || desiredWidth.Value <= 0 || desiredHeight.Value <= 0)
                {
                    error = $"Could not resolve {a.shape} bridge width and height.";
                    return false;
                }

                var pWidth = bridge.get_Parameter(BuiltInParameter.RBS_CURVE_WIDTH_PARAM);
                var pHeight = bridge.get_Parameter(BuiltInParameter.RBS_CURVE_HEIGHT_PARAM);
                if (pWidth == null || pWidth.IsReadOnly || pWidth.StorageType != StorageType.Double ||
                    pHeight == null || pHeight.IsReadOnly || pHeight.StorageType != StorageType.Double)
                {
                    error = $"Could not set {a.shape} bridge width and height.";
                    return false;
                }

                pWidth.Set(desiredWidth.Value);
                pHeight.Set(desiredHeight.Value);
                return true;
            }

            error = $"Unsupported connector shape: {a.shape}.";
            return false;
        }

        private static List<long> ReadSystemAuditDisconnectedIds(object payload)
        {
            var outList = new List<long>();
            try
            {
                using var doc = JsonDocument.Parse(JsonSerializer.Serialize(payload));
                if (!doc.RootElement.TryGetProperty("systemAudit", out var sa) || sa.ValueKind != JsonValueKind.Object) return outList;
                if (!sa.TryGetProperty("disconnectedIds", out var arr) || arr.ValueKind != JsonValueKind.Array) return outList;
                foreach (var idEl in arr.EnumerateArray())
                {
                    if (idEl.ValueKind == JsonValueKind.Number && idEl.TryGetInt64(out var id) && id > 0) outList.Add(id);
                }
            }
            catch
            {
                // ignore parse failures
            }
            return outList;
        }

        private static ElementId? ResolveDuctTypeId(Document doc, OpenConnectorInfo a, OpenConnectorInfo b)
        {
            try
            {
                var ownerA = a.connector.Owner;
                if (ownerA is Duct ductA) return ductA.DuctType?.Id;
            }
            catch { }

            try
            {
                var ownerB = b.connector.Owner;
                if (ownerB is Duct ductB) return ductB.DuctType?.Id;
            }
            catch { }

            var adjacentTypeId = TryResolveAdjacentDuctTypeId(a.connector) ?? TryResolveAdjacentDuctTypeId(b.connector);
            if (adjacentTypeId != null && RevitBridge.Common.ElementIdCompat.GetValue(adjacentTypeId) > 0) return adjacentTypeId;

            try
            {
                var any = new FilteredElementCollector(doc)
                    .OfClass(typeof(DuctType))
                    .Cast<DuctType>()
                    .FirstOrDefault(type =>
                    {
                        try { return type.Shape == a.shape; }
                        catch { return false; }
                    });
                return any?.Id;
            }
            catch
            {
                return null;
            }
        }

        private enum ContinuityRouteKind
        {
            None,
            Direct,
            Orthogonal
        }

        private static ContinuityRouteKind ClassifyRepairRoute(
            OpenConnectorInfo a,
            OpenConnectorInfo b,
            out XYZ corner)
        {
            corner = XYZ.Zero;
            var delta = b.origin - a.origin;
            var distance = delta.GetLength();
            if (distance <= 1e-9) return ContinuityRouteKind.None;
            var directionA = NormalizeOrZero(a.direction);
            var directionB = NormalizeOrZero(b.direction);
            if (directionA.IsZeroLength() || directionB.IsZeroLength())
                return ContinuityRouteKind.None;

            var unitAB = delta.Normalize();
            var facesFromA = directionA.DotProduct(unitAB);
            var facesFromB = directionB.DotProduct(unitAB.Negate());
            var directionDot = directionA.DotProduct(directionB);
            if (facesFromA >= 0.85 && facesFromB >= 0.85 && directionDot <= -0.85)
                return ContinuityRouteKind.Direct;

            if (Math.Abs(directionDot) > 0.15)
                return ContinuityRouteKind.None;

            var w0 = a.origin - b.origin;
            var denominator = 1.0 - directionDot * directionDot;
            if (Math.Abs(denominator) <= 1e-9)
                return ContinuityRouteKind.None;

            var d = directionA.DotProduct(w0);
            var e = directionB.DotProduct(w0);
            var distanceFromA = (directionDot * e - d) / denominator;
            var distanceFromB = (e - directionDot * d) / denominator;
            if (distanceFromA <= OpenConnectorMergeToleranceFt ||
                distanceFromB <= OpenConnectorMergeToleranceFt)
            {
                return ContinuityRouteKind.None;
            }

            var cornerFromA = a.origin + directionA.Multiply(distanceFromA);
            var cornerFromB = b.origin + directionB.Multiply(distanceFromB);
            if (cornerFromA.DistanceTo(cornerFromB) > OpenConnectorMergeToleranceFt)
                return ContinuityRouteKind.None;

            corner = (cornerFromA + cornerFromB).Multiply(0.5);
            return ContinuityRouteKind.Orthogonal;
        }

        private static XYZ TryGetConnectorDirection(Connector connector)
        {
            try
            {
                return NormalizeOrZero(connector.CoordinateSystem?.BasisZ ?? XYZ.Zero);
            }
            catch
            {
                return XYZ.Zero;
            }
        }

        private static XYZ NormalizeOrZero(XYZ value)
        {
            if (value == null || value.IsZeroLength()) return XYZ.Zero;
            try { return value.Normalize(); }
            catch { return XYZ.Zero; }
        }

        private static Duct? CreateProfiledBridge(
            Document doc,
            ElementId systemTypeId,
            ElementId ductTypeId,
            ElementId levelId,
            XYZ start,
            XYZ end,
            OpenConnectorInfo a,
            OpenConnectorInfo b,
            double targetSizeFt,
            out string error)
        {
            error = "";
            var bridge = Duct.Create(doc, systemTypeId, ductTypeId, levelId, start, end);
            if (bridge == null)
            {
                error = "Duct.Create returned null.";
                return null;
            }
            if (!ApplyBridgeProfile(bridge, a, b, targetSizeFt, out error))
                return null;
            return bridge;
        }

        private static bool TryResolveBridgeEnds(
            Duct bridge,
            XYZ start,
            XYZ end,
            out Connector startConnector,
            out Connector endConnector)
        {
            startConnector = null!;
            endConnector = null!;
            var connectors = MepSystemUtil.GetConnectors(bridge).ToList();
            if (connectors.Count < 2) return false;
            startConnector = connectors.OrderBy(connector => connector.Origin.DistanceTo(start)).First();
            endConnector = connectors.OrderBy(connector => connector.Origin.DistanceTo(end)).First();
            return startConnector != endConnector;
        }

        private static ElementId? TryResolveAdjacentDuctTypeId(Connector connector)
        {
            if (connector == null) return null;
            try
            {
                foreach (var ownerConnector in MepSystemUtil.GetConnectors(connector.Owner))
                {
                    ConnectorSet? refs = null;
                    try { refs = ownerConnector.AllRefs; } catch { refs = null; }
                    if (refs == null) continue;
                    foreach (Connector reference in refs)
                    {
                        if (reference?.Owner is Duct adjacentDuct &&
                            reference.Shape == connector.Shape)
                        {
                            return adjacentDuct.DuctType?.Id;
                        }
                    }
                }
            }
            catch { }
            return null;
        }

        private static ElementId? ResolveSystemTypeId(Document doc, OpenConnectorInfo a, OpenConnectorInfo b)
        {
            var fromOwners = new[] { a.connector.Owner, b.connector.Owner };
            foreach (var owner in fromOwners)
            {
                if (owner == null) continue;
                try
                {
                    if (owner is Duct duct)
                    {
                        var sys = duct.MEPSystem;
                        var typeId = sys?.GetTypeId();
                        if (typeId != null && RevitBridge.Common.ElementIdCompat.GetValue(typeId) > 0) return typeId;
                    }
                }
                catch { }

                try
                {
                    var p = owner.get_Parameter(BuiltInParameter.RBS_DUCT_SYSTEM_TYPE_PARAM);
                    if (p != null && p.StorageType == StorageType.ElementId)
                    {
                        var id = p.AsElementId();
                        if (id != null && RevitBridge.Common.ElementIdCompat.GetValue(id) > 0) return id;
                    }
                }
                catch { }
            }

            try
            {
                var mech = new FilteredElementCollector(doc)
                    .OfClass(typeof(MechanicalSystemType))
                    .Cast<MechanicalSystemType>()
                    .FirstOrDefault();
                if (mech != null) return mech.Id;
            }
            catch { }

            try
            {
                var any = new FilteredElementCollector(doc)
                    .OfClass(typeof(MEPSystemType))
                    .Cast<MEPSystemType>()
                    .FirstOrDefault();
                return any?.Id;
            }
            catch
            {
                return null;
            }
        }

        private static ElementId? ResolveLevelId(Document doc, OpenConnectorInfo a, OpenConnectorInfo b)
        {
            var fromOwners = new[] { a.connector.Owner, b.connector.Owner };
            foreach (var owner in fromOwners)
            {
                if (owner == null) continue;
                try
                {
                    var id = owner.LevelId;
                    if (id != null && RevitBridge.Common.ElementIdCompat.GetValue(id) > 0) return id;
                }
                catch { }

                try
                {
                    var p = owner.get_Parameter(BuiltInParameter.RBS_START_LEVEL_PARAM);
                    if (p != null && p.StorageType == StorageType.ElementId)
                    {
                        var id = p.AsElementId();
                        if (id != null && RevitBridge.Common.ElementIdCompat.GetValue(id) > 0) return id;
                    }
                }
                catch { }
            }

            try
            {
                var z = (a.origin.Z + b.origin.Z) / 2.0;
                var level = new FilteredElementCollector(doc)
                    .OfClass(typeof(Level))
                    .Cast<Level>()
                    .OrderBy(l => Math.Abs(l.Elevation - z))
                    .FirstOrDefault();
                return level?.Id;
            }
            catch
            {
                return null;
            }
        }

        internal static CreatedSegmentAudit AuditCreatedRepairSegments(Document doc, IEnumerable<long> createdSegmentIds, IEnumerable<long> continuityScopeIds)
        {
            var result = new CreatedSegmentAudit();
            if (doc == null) return result;

            var createdIds = (createdSegmentIds ?? Enumerable.Empty<long>()).Where(x => x > 0).Distinct().ToList();
            result.createdCount = createdIds.Count;
            if (createdIds.Count == 0) return result;

            var scopeIdSet = new HashSet<long>((continuityScopeIds ?? Enumerable.Empty<long>()).Where(x => x > 0));
            var touchedSystems = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            foreach (var sid in scopeIdSet)
            {
                var se = doc.GetElement(RevitBridge.Common.ElementIdCompat.Create(sid));
                if (se == null) continue;
                var sn = MepSystemUtil.TryGetSystemName(se);
                if (!string.IsNullOrWhiteSpace(sn)) touchedSystems.Add(sn!);
            }

            foreach (var id in createdIds)
            {
                var e = doc.GetElement(RevitBridge.Common.ElementIdCompat.Create(id));
                if (e == null)
                {
                    result.isolatedCount++;
                    result.isolatedIds.Add(id);
                    result.details.Add(new { id, isolated = true, systemMismatch = false, reason = "CreatedSegmentMissing" });
                    continue;
                }

                var connectedOwners = MepSystemUtil.GetConnectedOwnerElementIds(e)
                    .Where(x => x != null && RevitBridge.Common.ElementIdCompat.GetValue(x) > 0)
                    .Select(x => RevitBridge.Common.ElementIdCompat.GetValue(x))
                    .Distinct()
                    .ToList();

                var connectedToScope = connectedOwners.Any(scopeIdSet.Contains);
                var isolated = connectedOwners.Count < 2 || !connectedToScope;
                if (isolated)
                {
                    result.isolatedCount++;
                    result.isolatedIds.Add(id);
                }

                var sys = MepSystemUtil.TryGetSystemName(e);
                var systemMismatch = touchedSystems.Count > 0 && !string.IsNullOrWhiteSpace(sys) && !touchedSystems.Contains(sys!);
                if (systemMismatch)
                {
                    result.systemMismatchCount++;
                    result.systemMismatchIds.Add(id);
                }

                result.details.Add(new
                {
                    id,
                    isolated,
                    systemMismatch,
                    systemName = sys,
                    connectedOwnerCount = connectedOwners.Count,
                    connectedOwners = connectedOwners.Take(30).ToList()
                });
            }

            return result;
        }

        private static PostConditionResult EvaluatePostCondition(
            Document doc,
            IEnumerable<long> scopedIds,
            double targetSizeFt,
            bool includeFittings,
            bool includeTerminals,
            string? systemClassification)
        {
            var result = new PostConditionResult();
            if (doc == null) return result;

            var unresolvedCap = 200;
            foreach (var id in scopedIds ?? Enumerable.Empty<long>())
            {
                var e = doc.GetElement(RevitBridge.Common.ElementIdCompat.Create(id));
                if (e == null) continue;

                var catId = RevitBridge.Common.ElementIdCompat.GetValue(e.Category?.Id);
                var isFitting = catId == (int)BuiltInCategory.OST_DuctFitting;
                var isTerminal = catId == (int)BuiltInCategory.OST_DuctTerminal;

                if ((isFitting && !includeFittings) || (isTerminal && !includeTerminals)) continue;
                if (!isFitting && !isTerminal) continue;
                if (!MepSystemUtil.ElementMatchesSystemClassification(e, systemClassification)) continue;

                result.targetedCount++;
                var diameters = ProbeRoundDiametersFt(e);
                var matched = diameters.Any(d => Math.Abs(d - targetSizeFt) <= SizeToleranceFt);
                if (matched)
                {
                    result.matchedTargetCount++;
                    continue;
                }

                result.unresolvedCount++;
                if (result.unresolved.Count >= unresolvedCap) continue;

                result.unresolved.Add(new
                {
                    id = RevitBridge.Common.ElementIdCompat.GetValue(e.Id),
                    category = SelectionUtil.GetCategoryToken(e) ?? e.Category?.Name ?? "",
                    system = MepSystemUtil.TryGetSystemName(e),
                    expectedDiameter = LengthTextUtil.FormatLength(doc, targetSizeFt),
                    expectedDiameterFt = targetSizeFt,
                    actualRoundDiametersFt = diameters,
                    actualRoundDiameters = diameters.Select(d => LengthTextUtil.FormatLength(doc, d)).ToList(),
                    reason = diameters.Count == 0 ? "NoRoundDiameterProbe" : "TargetMismatch"
                });
            }

            return result;
        }

        private static List<double> ProbeRoundDiametersFt(Element e)
        {
            var values = new HashSet<double>();

            try
            {
                foreach (var c in MepSystemUtil.GetConnectors(e))
                {
                    if (c == null) continue;
                    if (c.Shape != ConnectorProfileType.Round) continue;
                    var d = 2.0 * c.Radius;
                    if (d > 0) values.Add(d);
                }
            }
            catch
            {
                // ignore
            }

            try
            {
                var p = GetRoundDiameterParam(e);
                if (p != null && p.StorageType == StorageType.Double)
                {
                    var v = p.AsDouble();
                    if (v > 0) values.Add(v);
                }
            }
            catch
            {
                // ignore
            }

            return values.OrderBy(x => x).ToList();
        }

        private static Parameter? GetRoundDiameterParam(Element e)
        {
            try
            {
                var p = e.get_Parameter(BuiltInParameter.RBS_CURVE_DIAMETER_PARAM);
                if (p != null) return p;
            }
            catch
            {
                // ignore
            }

            try
            {
                return e.LookupParameter("Diameter") ?? e.LookupParameter("Nominal Diameter");
            }
            catch
            {
                return null;
            }
        }

        private static object WriteArtifacts(List<ChangeRow> rows)
        {
            var dir = WorkspacePaths.EnsureDir("artifacts", "mep");
            var stamp = DateTime.Now.ToString("yyyyMMdd_HHmmss", CultureInfo.InvariantCulture);
            var baseName = "resize_ductwork_by_scope_" + stamp;
            var jsonPath = Path.Combine(dir, baseName + ".json");
            var csvPath = Path.Combine(dir, baseName + ".csv");

            try
            {
                var json = JsonSerializer.Serialize(new
                {
                    generatedAt = DateTime.Now.ToString("o", CultureInfo.InvariantCulture),
                    count = rows.Count,
                    rows
                }, new JsonSerializerOptions { WriteIndented = true });
                File.WriteAllText(jsonPath, json, Encoding.UTF8);
            }
            catch
            {
                // ignore
            }

            try
            {
                var sb = new StringBuilder();
                sb.AppendLine("elementId,category,old size,new size,type changes,system");
                foreach (var r in rows)
                {
                    sb.Append(r.elementId.ToString(CultureInfo.InvariantCulture)).Append(',');
                    sb.Append(Csv(r.category)).Append(',');
                    sb.Append(Csv(r.oldSize)).Append(',');
                    sb.Append(Csv(r.newSize)).Append(',');
                    sb.Append(Csv(r.typeChanges)).Append(',');
                    sb.Append(Csv(r.system)).AppendLine();
                }
                File.WriteAllText(csvPath, sb.ToString(), Encoding.UTF8);
            }
            catch
            {
                // ignore
            }

            return new { jsonPath, csvPath, count = rows.Count };
        }

        private static string Csv(string? raw)
        {
            var s = raw ?? "";
            if (!s.Contains(",") && !s.Contains("\"") && !s.Contains("\n") && !s.Contains("\r")) return s;
            return "\"" + s.Replace("\"", "\"\"") + "\"";
        }
    }
}
