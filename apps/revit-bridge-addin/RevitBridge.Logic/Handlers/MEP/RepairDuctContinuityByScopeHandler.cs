using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text.Json;
using System.Threading.Tasks;
using Autodesk.Revit.DB;
using Autodesk.Revit.UI;
using RevitBridge.Common;
using RevitBridge.Logic.Handlers.Core;

namespace RevitBridge.Logic.Handlers.MEP
{
    public sealed class RepairDuctContinuityByScopeHandler : IRequestHandler
    {
        public sealed class ScopeSpec
        {
            public string roomNumber { get; set; } = "";
            public string verticalScope { get; set; } = "room+plenum"; // room | plenum | room+plenum
            public string roomMode { get; set; } = "auto"; // auto | roomAware | geometry
        }

        public sealed class Params
        {
            public ScopeSpec? scope { get; set; }
            public List<long> elementIds { get; set; } = new List<long>();
            public string? expectedModelPath { get; set; }
            public string? systemClassification { get; set; }
            public bool includeTerminals { get; set; } = false;
            public bool verify { get; set; } = true;
            public bool dryRun { get; set; } = true;
            public double maxGapFt { get; set; } = 1.5;
            public int maxRepairs { get; set; } = 8;
            public int? maxElements { get; set; } = 5000;
        }

        public Task<object> Handle(UIApplication app, string jsonData)
        {
            var p = string.IsNullOrWhiteSpace(jsonData) ? new Params() : (JsonSerializer.Deserialize<Params>(jsonData) ?? new Params());

            var uidoc = app.ActiveUIDocument;
            if (uidoc == null) throw new InvalidOperationException("No active UI document.");
            var doc = uidoc.Document;
            AssertExpectedModel(doc, p.expectedModelPath);

            var includeCategories = new List<string> { "Ducts", "Duct Fittings" };
            if (p.includeTerminals) includeCategories.Add("Air Terminals");

            var maxElements = p.maxElements.HasValue && p.maxElements.Value > 0 ? Math.Min(p.maxElements.Value, 50000) : 5000;
            var maxGapFt = p.maxGapFt > 0 ? p.maxGapFt : 1.5;
            var maxRepairs = p.maxRepairs < 0 ? 0 : Math.Min(p.maxRepairs, 64);
            var warnings = new List<string>();
            var explicitIds = (p.elementIds ?? new List<long>())
                .Where(id => id > 0)
                .Distinct()
                .Take(maxElements + 1)
                .ToList();
            if (explicitIds.Count > maxElements)
                throw new ArgumentException($"elementIds exceeds maxElements ({maxElements}).");

            object scopeResult;
            List<long> scopedIds;
            if (explicitIds.Count > 0)
            {
                if (string.IsNullOrWhiteSpace(p.expectedModelPath))
                    throw new ArgumentException("expectedModelPath is required when elementIds are supplied.");
                scopedIds = explicitIds
                    .Where(id => doc.GetElement(ElementIdCompat.Create(id)) != null)
                    .ToList();
                scopeResult = new
                {
                    mode = "explicit_element_ids",
                    requestedCount = explicitIds.Count,
                    elementIds = scopedIds,
                    missingElementIds = explicitIds.Except(scopedIds).ToList()
                };
            }
            else
            {
                if (p.scope == null) throw new ArgumentException("scope or elementIds is required.");
                var roomNumber = (p.scope.roomNumber ?? "").Trim();
                if (roomNumber.Length == 0) throw new ArgumentException("scope.roomNumber is required.");
                var scopeReq = new DuctsBySpatialScopeHandler.Params
                {
                    roomNumber = roomNumber,
                    roomMode = p.scope.roomMode,
                    verticalScope = p.scope.verticalScope,
                    includeCategories = includeCategories,
                    systemClassification = p.systemClassification,
                    limit = maxElements
                };
                scopeResult = new DuctsBySpatialScopeHandler().Handle(app, JsonSerializer.Serialize(scopeReq)).GetAwaiter().GetResult();
                scopedIds = ReadIdList(scopeResult, "elementIds");
            }

            if (scopedIds.Count == 0)
            {
                return Task.FromResult<object>(new
                {
                    status = "Ok",
                    endpoint = "/revit/repair-duct-continuity-by-scope",
                    dryRun = p.dryRun,
                    scope = p.scope,
                    systemClassification = p.systemClassification,
                    counts = new
                    {
                        scopedCount = 0,
                        continuityScopeCount = 0,
                        preOpenConnectorCount = 0,
                        postOpenConnectorCount = 0,
                        repairedCount = 0
                    },
                    scopeResult,
                    warnings
                });
            }

            var continuityScopeIds = BuildContinuityScopeIds(doc, scopedIds, p.includeTerminals, maxElements);
            var preAudit = ResizeDuctworkByScopeHandler.EvaluateContinuity(
                app,
                doc,
                continuityScopeIds,
                p.systemClassification,
                Math.Min(maxElements, 20000),
                maxGapFt,
                warnings);

            var inferredTargetDiameterFt = InferTargetDiameterFt(doc, continuityScopeIds);
            var repairResult = new ResizeDuctworkByScopeHandler.ContinuityRepairResult
            {
                requested = maxRepairs > 0,
                dryRun = p.dryRun,
                attempts = 0,
                repairedCount = 0
            };

            if (maxRepairs > 0 && preAudit.openConnectorCount > 0)
            {
                repairResult = p.dryRun
                    ? ResizeDuctworkByScopeHandler.DryRunContinuityRepair(
                        doc,
                        continuityScopeIds,
                        inferredTargetDiameterFt,
                        maxGapFt,
                        maxRepairs,
                        warnings)
                    : ResizeDuctworkByScopeHandler.ApplyContinuityRepair(
                        doc,
                        continuityScopeIds,
                        inferredTargetDiameterFt,
                        maxGapFt,
                        maxRepairs,
                        warnings);

                try { doc.Regenerate(); } catch { }
                if (!p.dryRun)
                {
                    try { uidoc.RefreshActiveView(); } catch { }
                }
            }

            var postAudit = p.dryRun
                ? preAudit
                : ResizeDuctworkByScopeHandler.EvaluateContinuity(
                    app,
                    doc,
                    continuityScopeIds,
                    p.systemClassification,
                    Math.Min(maxElements, 20000),
                    maxGapFt,
                    warnings);

            var createdSegmentAudit = ResizeDuctworkByScopeHandler.AuditCreatedRepairSegments(
                doc,
                repairResult.createdSegmentIds,
                continuityScopeIds);

            if (!p.dryRun && (createdSegmentAudit.isolatedCount > 0 || createdSegmentAudit.systemMismatchCount > 0))
            {
                warnings.Add($"Created repair segment audit found issues: isolated={createdSegmentAudit.isolatedCount}, systemMismatch={createdSegmentAudit.systemMismatchCount}.");
            }

            object? verifyResult = null;
            if (p.verify && continuityScopeIds.Count > 0)
            {
                try
                {
                    var highlightReq = new HighlightAndExportHandler.Params
                    {
                        viewId = RevitBridge.Common.ElementIdCompat.GetValue(uidoc.ActiveView?.Id),
                        elementIds = continuityScopeIds.Take(300).ToList()
                    };
                    verifyResult = new HighlightAndExportHandler().Handle(app, JsonSerializer.Serialize(highlightReq)).GetAwaiter().GetResult();
                }
                catch (Exception ex)
                {
                    warnings.Add($"verify capture failed: {ex.Message}");
                }
            }

            var status = p.dryRun
                ? (repairResult.repairedCount > 0 && repairResult.rollbackVerified ? "Dry Run Ready" : "Dry Run")
                : (postAudit.ok && createdSegmentAudit.isolatedCount == 0 && createdSegmentAudit.systemMismatchCount == 0 ? "Applied" : "Partial");
            return Task.FromResult<object>(new
            {
                status,
                endpoint = "/revit/repair-duct-continuity-by-scope",
                dryRun = p.dryRun,
                scope = p.scope,
                systemClassification = p.systemClassification,
                includeTerminals = p.includeTerminals,
                maxGapFt,
                maxRepairs,
                inferredTargetDiameter = LengthTextUtil.FormatLength(doc, inferredTargetDiameterFt),
                inferredTargetDiameterFt,
                counts = new
                {
                    scopedCount = scopedIds.Count,
                    continuityScopeCount = continuityScopeIds.Count,
                    preOpenConnectorCount = preAudit.openConnectorCount,
                    postOpenConnectorCount = postAudit.openConnectorCount,
                    preDisconnectedTouchedCount = preAudit.disconnectedTouchedCount,
                    postDisconnectedTouchedCount = postAudit.disconnectedTouchedCount,
                    repairedCount = repairResult.repairedCount,
                    isolatedCreatedCount = createdSegmentAudit.isolatedCount,
                    systemMismatchCreatedCount = createdSegmentAudit.systemMismatchCount
                },
                scopeResult,
                preAudit,
                repairResult,
                postAudit,
                createdSegmentAudit,
                verify = verifyResult,
                warnings
            });
        }

        private static void AssertExpectedModel(Document doc, string? expectedModelPath)
        {
            if (string.IsNullOrWhiteSpace(expectedModelPath)) return;
            var expected = Path.GetFullPath(expectedModelPath);
            var actual = string.IsNullOrWhiteSpace(doc.PathName) ? "" : Path.GetFullPath(doc.PathName);
            if (!string.Equals(expected, actual, StringComparison.OrdinalIgnoreCase))
                throw new InvalidOperationException($"expected_model_path_mismatch:{expected}:{actual}");
        }

        private static List<long> BuildContinuityScopeIds(Document doc, IEnumerable<long> scopedIds, bool includeTerminals, int cap)
        {
            var outSet = new HashSet<long>();
            foreach (var id in scopedIds ?? Enumerable.Empty<long>())
            {
                if (id <= 0) continue;
                if (outSet.Count >= cap) break;
                var e = doc.GetElement(RevitBridge.Common.ElementIdCompat.Create(id));
                if (e == null) continue;
                if (!IsContinuityCategory(e, includeTerminals)) continue;
                outSet.Add(id);
            }

            // Pull one-hop neighbors so accessories/connectors just outside room scope can be repaired.
            foreach (var id in outSet.ToList())
            {
                if (outSet.Count >= cap) break;
                var e = doc.GetElement(RevitBridge.Common.ElementIdCompat.Create(id));
                if (e == null) continue;
                foreach (var nid in MepSystemUtil.GetConnectedOwnerElementIds(e))
                {
                    if (outSet.Count >= cap) break;
                    if (nid == null || RevitBridge.Common.ElementIdCompat.GetValue(nid) <= 0) continue;
                    var n = doc.GetElement(nid);
                    if (n == null) continue;
                    if (!IsContinuityCategory(n, includeTerminals)) continue;
                    outSet.Add(RevitBridge.Common.ElementIdCompat.GetValue(n.Id));
                }
            }

            return outSet.OrderBy(x => x).ToList();
        }

        private static bool IsContinuityCategory(Element e, bool includeTerminals)
        {
            var catId = RevitBridge.Common.ElementIdCompat.GetValue(e.Category?.Id);
            if (catId == (int)BuiltInCategory.OST_DuctCurves) return true;
            if (catId == (int)BuiltInCategory.OST_DuctFitting) return true;
            if (catId == (int)BuiltInCategory.OST_DuctAccessory) return true;
            if (includeTerminals && catId == (int)BuiltInCategory.OST_DuctTerminal) return true;
            return false;
        }

        private static double InferTargetDiameterFt(Document doc, IEnumerable<long> elementIds)
        {
            var values = new List<double>();
            foreach (var id in elementIds ?? Enumerable.Empty<long>())
            {
                if (id <= 0) continue;
                var e = doc.GetElement(RevitBridge.Common.ElementIdCompat.Create(id));
                if (e == null) continue;

                try
                {
                    var p = e.get_Parameter(BuiltInParameter.RBS_CURVE_DIAMETER_PARAM);
                    if (p != null && p.StorageType == StorageType.Double)
                    {
                        var d = p.AsDouble();
                        if (d > 0) values.Add(d);
                    }
                }
                catch { }

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
                catch { }
            }

            if (values.Count == 0) return 0.5; // 6"
            values.Sort();
            return values[values.Count / 2];
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
    }
}
