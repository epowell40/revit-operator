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
    public class ResizeDuctsByScopeHandler : IRequestHandler
    {
        public sealed class ScopeSpec
        {
            public string type { get; set; } = ""; // equipment | room | view
            public string? mark { get; set; }
            public string? roomNumber { get; set; }
            public string? plenumTopLevelName { get; set; }
            public long? viewId { get; set; }
        }

        public sealed class Params
        {
            public ScopeSpec? scope { get; set; }
            public string? systemClassification { get; set; }
            public string? fromDiameter { get; set; }
            public string toDiameter { get; set; } = "";
            public bool includeFittings { get; set; } = true;
            public bool includeTerminals { get; set; } = true;
            public bool includeEquipment { get; set; } = true;
            public string scopeMode { get; set; } = "connectedRun"; // connectedRun | bboxIntersect | centerlineIntersect
            public string roomMode { get; set; } = "geometry"; // geometry | roomAware (for room scope)
            public string verticalScope { get; set; } = "plenum"; // room | plenum (room scope)
            public bool stopAtBranchFittings { get; set; } = true;
            public bool stopAtTransitions { get; set; } = true;
            public string resolveTypeDriven { get; set; } = "auto"; // auto | duplicate | skip
            public bool eliminateTransitions { get; set; } = false; // when true, include equipment + aggressive type-driven resolution
            public bool verify { get; set; } = false;
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

        public Task<object> Handle(UIApplication app, string jsonData)
        {
            var p = string.IsNullOrWhiteSpace(jsonData) ? new Params() : (JsonSerializer.Deserialize<Params>(jsonData) ?? new Params());
            if (p.scope == null) throw new ArgumentException("scope is required.");

            var uidoc = app.ActiveUIDocument;
            if (uidoc == null) throw new InvalidOperationException("No active UI document.");
            var doc = uidoc.Document;

            var toText = (p.toDiameter ?? "").Trim();
            if (toText.Length == 0) throw new ArgumentException("toDiameter is required.");
            if (!LengthTextUtil.TryParseLengthToFeet(doc, toText, out var toDiameterFt, out var toErr) || toDiameterFt <= 0)
                throw new InvalidOperationException($"Could not parse toDiameter: {toErr}");

            double? fromDiameterFt = null;
            var fromText = (p.fromDiameter ?? "").Trim();
            if (fromText.Length > 0)
            {
                if (!LengthTextUtil.TryParseLengthToFeet(doc, fromText, out var parsedFrom, out var fromErr))
                    throw new InvalidOperationException($"Could not parse fromDiameter: {fromErr}");
                fromDiameterFt = parsedFrom;
            }

            var mode = (p.scopeMode ?? "connectedRun").Trim();
            if (mode.Length == 0) mode = "connectedRun";

            var scopeType = (p.scope.type ?? "").Trim().ToLowerInvariant();
            if (scopeType != "equipment" && scopeType != "room" && scopeType != "view")
                throw new ArgumentException("scope.type must be one of: equipment | room | view.");

            var max = p.maxElements.HasValue && p.maxElements.Value > 0 ? Math.Min(p.maxElements.Value, 50000) : 5000;
            var warnings = new List<string>();
            var resolveTypeDriven = (p.resolveTypeDriven ?? "auto").Trim();
            if (resolveTypeDriven.Length == 0) resolveTypeDriven = "auto";
            if (!resolveTypeDriven.Equals("auto", StringComparison.OrdinalIgnoreCase) &&
                !resolveTypeDriven.Equals("duplicate", StringComparison.OrdinalIgnoreCase) &&
                !resolveTypeDriven.Equals("skip", StringComparison.OrdinalIgnoreCase))
            {
                throw new ArgumentException("resolveTypeDriven must be one of: auto | duplicate | skip.");
            }

            var seedIds = new List<long>();
            var scopedIds = new HashSet<long>();
            object? scopeDebug = null;

            if (scopeType == "equipment")
            {
                var mark = (p.scope.mark ?? "").Trim();
                if (mark.Length == 0) throw new ArgumentException("scope.mark is required for equipment scope.");

                var candidates = new FilteredElementCollector(doc)
                    .OfCategory(BuiltInCategory.OST_MechanicalEquipment)
                    .WhereElementIsNotElementType()
                    .ToElements()
                    .Where(e => string.Equals((e.LookupParameter("Mark")?.AsString() ?? "").Trim(), mark, StringComparison.OrdinalIgnoreCase))
                    .Select(e => RevitBridge.Common.ElementIdCompat.GetValue(e.Id))
                    .ToList();

                if (candidates.Count != 1)
                {
                    return Task.FromResult<object>(new
                    {
                        status = "Error",
                        message = candidates.Count == 0 ? $"No equipment found with Mark '{mark}'." : $"Multiple equipment elements found with Mark '{mark}'.",
                        candidates
                    });
                }

                var equipmentId = candidates[0];
                seedIds.Add(equipmentId);

                var traceReq = new TraceConnectedNetworkHandler.Params
                {
                    startElementId = equipmentId,
                    inferSystemFromStart = true,
                    stopAtBranchFittings = p.stopAtBranchFittings,
                    stopAtTransitions = p.stopAtTransitions,
                    includeDucts = true,
                    includeFittings = p.includeFittings,
                    includeAccessories = true,
                    includeTerminals = p.includeTerminals,
                    includeEquipment = true,
                    includeOtherCategories = false,
                    maxElements = max,
                    includeSystemAudit = false
                };

                var traceResult = new TraceConnectedNetworkHandler().Handle(app, JsonSerializer.Serialize(traceReq)).GetAwaiter().GetResult();
                foreach (var id in ReadIdList(traceResult, "elementIdsOrdered")) scopedIds.Add(id);

                scopeDebug = new { equipmentId, mark };
            }
            else if (scopeType == "room")
            {
                var roomNumber = (p.scope.roomNumber ?? "").Trim();
                var topLevel = (p.scope.plenumTopLevelName ?? "").Trim();
                var verticalScope = (p.verticalScope ?? "plenum").Trim();
                if (verticalScope.Length == 0) verticalScope = "plenum";
                if (roomNumber.Length == 0) throw new ArgumentException("scope.roomNumber is required for room scope.");
                if (verticalScope.Equals("plenum", StringComparison.OrdinalIgnoreCase) && topLevel.Length == 0)
                    throw new ArgumentException("scope.plenumTopLevelName is required for room scope when verticalScope=plenum.");

                var roomMode = (p.roomMode ?? "geometry").Trim();
                if (roomMode.Length == 0) roomMode = "geometry";
                if (!roomMode.Equals("geometry", StringComparison.OrdinalIgnoreCase) &&
                    !roomMode.Equals("roomAware", StringComparison.OrdinalIgnoreCase))
                {
                    throw new ArgumentException("roomMode must be one of: geometry | roomAware.");
                }
                if (!verticalScope.Equals("room", StringComparison.OrdinalIgnoreCase) &&
                    !verticalScope.Equals("plenum", StringComparison.OrdinalIgnoreCase))
                {
                    throw new ArgumentException("verticalScope must be one of: room | plenum.");
                }

                if (roomMode.Equals("roomAware", StringComparison.OrdinalIgnoreCase))
                {
                    var cats = new List<string> { "OST_DuctCurves" };
                    if (p.includeFittings) cats.Add("OST_DuctFitting");
                    if (p.includeTerminals) cats.Add("OST_DuctTerminal");
                    if (p.includeEquipment || p.eliminateTransitions) cats.Add("OST_MechanicalEquipment");

                    var roomReq = new RevitBridge.Logic.Handlers.RoomContentsHandler.Params
                    {
                        roomNumber = roomNumber,
                        mode = "roomAware",
                        verticalScope = verticalScope.Equals("room", StringComparison.OrdinalIgnoreCase) ? "room" : "plenum",
                        categories = cats,
                        systemClassification = p.systemClassification,
                        includeConnectedOutsideRoom = p.eliminateTransitions || p.includeEquipment,
                        limit = max
                    };
                    var roomContents = new RevitBridge.Logic.Handlers.RoomContentsHandler().Handle(app, JsonSerializer.Serialize(roomReq)).GetAwaiter().GetResult();
                    foreach (var id in ReadIdList(roomContents, "elementIds")) scopedIds.Add(id);
                    foreach (var id in ReadIdList(roomContents, "connectedOutsideRoomIds")) scopedIds.Add(id);
                    scopeDebug = roomContents;
                }
                else
                {
                    if (verticalScope.Equals("room", StringComparison.OrdinalIgnoreCase))
                    {
                        var cats = new List<string> { "OST_DuctCurves" };
                        if (p.includeFittings) cats.Add("OST_DuctFitting");
                        if (p.includeTerminals) cats.Add("OST_DuctTerminal");
                        if (p.includeEquipment || p.eliminateTransitions) cats.Add("OST_MechanicalEquipment");

                        var roomReq = new RevitBridge.Logic.Handlers.RoomContentsHandler.Params
                        {
                            roomNumber = roomNumber,
                            mode = "geometry",
                            verticalScope = "room",
                            categories = cats,
                            systemClassification = p.systemClassification,
                            includeConnectedOutsideRoom = p.eliminateTransitions || p.includeEquipment,
                            limit = max
                        };
                        var roomContents = new RevitBridge.Logic.Handlers.RoomContentsHandler().Handle(app, JsonSerializer.Serialize(roomReq)).GetAwaiter().GetResult();
                        foreach (var id in ReadIdList(roomContents, "elementIds")) scopedIds.Add(id);
                        foreach (var id in ReadIdList(roomContents, "connectedOutsideRoomIds")) scopedIds.Add(id);
                        scopeDebug = roomContents;
                    }
                    else
                    {
                        var intersectMode = mode.Equals("centerlineIntersect", StringComparison.OrdinalIgnoreCase) ? "centerline" : "bbox";
                        var cats = new List<string> { "OST_DuctCurves" };
                        if (p.includeFittings) cats.Add("OST_DuctFitting");
                        if (p.includeTerminals) cats.Add("OST_DuctTerminal");

                        var req = new RoomMepIntersectHandler.Params
                        {
                            roomNumber = roomNumber,
                            plenumTopLevelName = topLevel,
                            categories = cats,
                            systemClassification = p.systemClassification,
                            sizeEquals = fromText.Length > 0 ? fromText : null,
                            intersectMode = intersectMode,
                            limit = max
                        };

                        var roomResult = new RoomMepIntersectHandler().Handle(app, JsonSerializer.Serialize(req)).GetAwaiter().GetResult();
                        foreach (var id in ReadIdList(roomResult, "elementIds")) scopedIds.Add(id);

                        if (p.includeEquipment || p.eliminateTransitions)
                        {
                            var equipmentReq = new RevitBridge.Logic.Handlers.RoomContentsHandler.Params
                            {
                                roomNumber = roomNumber,
                                mode = "geometry",
                                verticalScope = "plenum",
                                categories = new List<string> { "OST_MechanicalEquipment" },
                                systemClassification = p.systemClassification,
                                includeConnectedOutsideRoom = p.eliminateTransitions,
                                limit = max
                            };
                            var equipmentResult = new RevitBridge.Logic.Handlers.RoomContentsHandler().Handle(app, JsonSerializer.Serialize(equipmentReq)).GetAwaiter().GetResult();
                            foreach (var id in ReadIdList(equipmentResult, "elementIds")) scopedIds.Add(id);
                            foreach (var id in ReadIdList(equipmentResult, "connectedOutsideRoomIds")) scopedIds.Add(id);
                        }

                        scopeDebug = roomResult;
                    }
                }
            }
            else
            {
                var viewId = p.scope.viewId.GetValueOrDefault();
                if (viewId <= 0) throw new ArgumentException("scope.viewId is required for view scope.");

                var view = doc.GetElement(RevitBridge.Common.ElementIdCompat.Create(viewId)) as View;
                if (view == null) throw new InvalidOperationException($"View {viewId} not found.");

                var bic = new List<BuiltInCategory> { BuiltInCategory.OST_DuctCurves };
                if (p.includeFittings) bic.Add(BuiltInCategory.OST_DuctFitting);
                if (p.includeTerminals) bic.Add(BuiltInCategory.OST_DuctTerminal);

                var c = new FilteredElementCollector(doc, view.Id).WhereElementIsNotElementType();
                if (bic.Count == 1) c.OfCategory(bic[0]);
                else c.WherePasses(new ElementMulticategoryFilter(bic));

                foreach (var e in c)
                {
                    if (e == null) continue;
                    scopedIds.Add(RevitBridge.Common.ElementIdCompat.GetValue(e.Id));
                    if (scopedIds.Count >= max) break;
                }

                scopeDebug = new { viewId = RevitBridge.Common.ElementIdCompat.GetValue(view.Id), viewName = view.Name };
            }

            var filtered = new List<Element>();
            foreach (var id in scopedIds)
            {
                var e = doc.GetElement(RevitBridge.Common.ElementIdCompat.Create(id));
                if (e == null) continue;
                if (!PassesSystemClassification(e, p.systemClassification)) continue;
                if (fromDiameterFt.HasValue && !PassesDiameterFilter(e, fromDiameterFt.Value)) continue;
                filtered.Add(e);
            }

            if (filtered.Count == 0)
            {
                return Task.FromResult<object>(new
                {
                    status = "Ok",
                    dryRun = p.dryRun,
                    scope = p.scope,
                    scopeMode = mode,
                    matchedCount = 0,
                    warnings
                });
            }

            var ductIds = filtered.Where(IsDuctCurve).Select(e => RevitBridge.Common.ElementIdCompat.GetValue(e.Id)).Distinct().ToList();
            var changeRows = new List<ChangeRow>();
            var ductChanges = new List<object>();

            if (!p.dryRun)
            {
                using (var t = new Transaction(doc, "Resize Ducts By Scope"))
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
                            if (Math.Abs(cur - toDiameterFt) > 1e-9)
                            {
                                pDia.Set(toDiameterFt);
                                changed = true;
                            }
                        }
                        else
                        {
                            ParameterValueUtil.TrySetFromString(pDia, LengthTextUtil.FormatLength(doc, toDiameterFt), out changed, out _);
                        }

                        var newValue = pDia.AsValueString() ?? pDia.AsString() ?? LengthTextUtil.FormatLength(doc, toDiameterFt);
                        ductChanges.Add(new { id, changed, oldSize = oldValue, newSize = newValue });
                        if (changed)
                        {
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
            var scopedFilteredIds = filtered.Select(x => RevitBridge.Common.ElementIdCompat.GetValue(x.Id)).ToList();
            if (p.includeFittings || p.includeTerminals)
            {
                var syncReq = new SyncConnectedSizesHandler.Params
                {
                    elementIds = scopedFilteredIds,
                    dryRun = p.dryRun,
                    maxElements = max,
                    resolveTypeDriven = resolveTypeDriven,
                    confirm = p.confirm
                };
                syncResult = new SyncConnectedSizesHandler().Handle(app, JsonSerializer.Serialize(syncReq)).GetAwaiter().GetResult();

                foreach (var row in ReadSyncChangeRows(syncResult))
                {
                    if (!changeRows.Any(x => x.elementId == row.elementId)) changeRows.Add(row);
                }
            }

            var typeSwapResults = new List<object>();
            if (!p.dryRun && syncResult != null && resolveTypeDriven.Equals("manual", StringComparison.OrdinalIgnoreCase))
            {
                foreach (var td in ReadTypeDriven(syncResult))
                {
                    try
                    {
                        var inst = doc.GetElement(RevitBridge.Common.ElementIdCompat.Create(td.instanceId));
                        if (inst == null) continue;

                        var type = doc.GetElement(inst.GetTypeId()) as ElementType;
                        if (type == null) continue;

                        var paramName = ResolveWritableTypeSizeParam(type);
                        if (paramName == null)
                        {
                            typeSwapResults.Add(new { id = td.instanceId, ok = false, reason = "NoWritableTypeSizeParameter" });
                            continue;
                        }

                        var swapReq = new RevitBridge.Logic.Handlers.DuplicateTypeAndSwapInstanceHandler.Params
                        {
                            instanceId = td.instanceId,
                            newTypeName = BuildScopedTypeName(type.Name, toText),
                            typeParamChanges = new List<RevitBridge.Logic.Handlers.DuplicateTypeAndSwapInstanceHandler.Change>
                            {
                                new RevitBridge.Logic.Handlers.DuplicateTypeAndSwapInstanceHandler.Change { parameterName = paramName, value = toText }
                            },
                            dryRun = false,
                            confirm = p.confirm
                        };

                        var swapRes = new RevitBridge.Logic.Handlers.DuplicateTypeAndSwapInstanceHandler().Handle(app, JsonSerializer.Serialize(swapReq)).GetAwaiter().GetResult();
                        typeSwapResults.Add(new { id = td.instanceId, ok = true, result = swapRes });

                        if (!changeRows.Any(x => x.elementId == td.instanceId))
                        {
                            changeRows.Add(new ChangeRow
                            {
                                elementId = td.instanceId,
                                category = SelectionUtil.GetCategoryToken(inst) ?? "",
                                oldSize = fromText,
                                newSize = toText,
                                typeChanges = "duplicate+swap",
                                system = MepSystemUtil.TryGetSystemName(inst) ?? ""
                            });
                        }
                    }
                    catch (Exception ex)
                    {
                        typeSwapResults.Add(new { id = td.instanceId, ok = false, error = ex.Message });
                    }
                }
            }

            object? verifyResult = null;
            if (p.verify && scopedFilteredIds.Count > 0)
            {
                try
                {
                    var verifyReq = new RevitBridge.Logic.Handlers.HighlightAndExportHandler.Params
                    {
                        viewId = RevitBridge.Common.ElementIdCompat.GetValue(uidoc.ActiveView?.Id),
                        elementIds = scopedFilteredIds.Take(300).ToList()
                    };
                    verifyResult = new RevitBridge.Logic.Handlers.HighlightAndExportHandler().Handle(app, JsonSerializer.Serialize(verifyReq)).GetAwaiter().GetResult();
                }
                catch (Exception ex)
                {
                    warnings.Add($"verify capture failed: {ex.Message}");
                }
            }

            var artifacts = WriteArtifacts(changeRows);

            return Task.FromResult<object>(new
            {
                status = p.dryRun ? "Dry Run" : "Applied",
                dryRun = p.dryRun,
                scope = p.scope,
                scopeMode = mode,
                roomMode = p.roomMode,
                verticalScope = p.verticalScope,
                systemClassification = p.systemClassification,
                fromDiameter = p.fromDiameter,
                toDiameter = p.toDiameter,
                resolveTypeDriven,
                eliminateTransitions = p.eliminateTransitions,
                counts = new
                {
                    scopedCount = scopedIds.Count,
                    matchedCount = filtered.Count,
                    ductsTargeted = ductIds.Count
                },
                scopeDebug,
                seeds = seedIds,
                ductChanges,
                syncResult,
                typeSwapResults,
                verify = verifyResult,
                artifact = artifacts,
                warnings
            });
        }

        private sealed class TypeDrivenRef
        {
            public long instanceId { get; set; }
        }

        private static List<TypeDrivenRef> ReadTypeDriven(object syncResult)
        {
            var outList = new List<TypeDrivenRef>();
            try
            {
                using (var doc = JsonDocument.Parse(JsonSerializer.Serialize(syncResult)))
                {
                    if (!doc.RootElement.TryGetProperty("typeDriven", out var td) || td.ValueKind != JsonValueKind.Array) return outList;
                    foreach (var e in td.EnumerateArray())
                    {
                        if (!e.TryGetProperty("id", out var idEl)) continue;
                        if (idEl.ValueKind != JsonValueKind.Number || !idEl.TryGetInt64(out var id)) continue;
                        outList.Add(new TypeDrivenRef { instanceId = id });
                    }
                }
            }
            catch { }
            return outList;
        }

        private static List<ChangeRow> ReadSyncChangeRows(object syncResult)
        {
            var outRows = new List<ChangeRow>();
            try
            {
                using (var doc = JsonDocument.Parse(JsonSerializer.Serialize(syncResult)))
                {
                    if (!doc.RootElement.TryGetProperty("changes", out var changes) || changes.ValueKind != JsonValueKind.Array) return outRows;
                    foreach (var c in changes.EnumerateArray())
                    {
                        if (!c.TryGetProperty("id", out var idEl) || idEl.ValueKind != JsonValueKind.Number || !idEl.TryGetInt64(out var id)) continue;
                        var changed = c.TryGetProperty("changed", out var ch) && ch.ValueKind == JsonValueKind.True;
                        if (!changed) continue;

                        var category = c.TryGetProperty("category", out var cat) && cat.ValueKind == JsonValueKind.String ? (cat.GetString() ?? "") : "";
                        var system = c.TryGetProperty("systemName", out var sys) && sys.ValueKind == JsonValueKind.String ? (sys.GetString() ?? "") : "";
                        var newSize = "";
                        if (c.TryGetProperty("desired", out var desired))
                        {
                            if (desired.ValueKind == JsonValueKind.Object)
                            {
                                if (desired.TryGetProperty("diameter", out var d) && d.ValueKind == JsonValueKind.String) newSize = d.GetString() ?? "";
                                else if (desired.TryGetProperty("width", out var w) && desired.TryGetProperty("height", out var h) && w.ValueKind == JsonValueKind.String && h.ValueKind == JsonValueKind.String)
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
            }
            catch { }
            return outRows;
        }

        private static List<long> ReadIdList(object payload, string key)
        {
            var outList = new List<long>();
            try
            {
                using (var doc = JsonDocument.Parse(JsonSerializer.Serialize(payload)))
                {
                    if (!doc.RootElement.TryGetProperty(key, out var arr) || arr.ValueKind != JsonValueKind.Array) return outList;
                    foreach (var idEl in arr.EnumerateArray())
                    {
                        if (idEl.ValueKind == JsonValueKind.Number && idEl.TryGetInt64(out var id) && id > 0) outList.Add(id);
                    }
                }
            }
            catch { }
            return outList;
        }

        private static object WriteArtifacts(List<ChangeRow> rows)
        {
            var dir = WorkspacePaths.EnsureDir("artifacts", "mep");
            var stamp = DateTime.Now.ToString("yyyyMMdd_HHmmss", CultureInfo.InvariantCulture);
            var baseName = "resize_ducts_by_scope_" + stamp;
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
            catch { }

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
            catch { }

            return new { jsonPath, csvPath, count = rows.Count };
        }

        private static string Csv(string? raw)
        {
            var s = raw ?? "";
            if (!s.Contains(",") && !s.Contains("\"") && !s.Contains("\n") && !s.Contains("\r")) return s;
            return "\"" + s.Replace("\"", "\"\"") + "\"";
        }

        private static string BuildScopedTypeName(string currentTypeName, string sizeText)
        {
            var suffix = (sizeText ?? "").Trim();
            if (suffix.Length == 0) suffix = "resized";
            return currentTypeName + " - " + suffix + " scoped";
        }

        private static string? ResolveWritableTypeSizeParam(ElementType type)
        {
            var names = new[]
            {
                "Diameter",
                "Nominal Diameter",
                "Duct Diameter",
                "Connector Diameter",
                "Duct Size",
                "Size",
                "Width",
                "Height"
            };

            foreach (var n in names)
            {
                try
                {
                    var p = type.LookupParameter(n);
                    if (p == null || p.IsReadOnly) continue;
                    return n;
                }
                catch { }
            }
            return null;
        }

        private static bool IsDuctCurve(Element e)
        {
            try { return RevitBridge.Common.ElementIdCompat.GetValue(e.Category?.Id) == (int)BuiltInCategory.OST_DuctCurves; }
            catch { return false; }
        }

        private static bool PassesSystemClassification(Element e, string? required)
        {
            return MepSystemUtil.ElementMatchesSystemClassification(e, required);
        }

        private static bool PassesDiameterFilter(Element e, double targetFt)
        {
            try
            {
                if (IsDuctCurve(e))
                {
                    var p = GetRoundDiameterParam(e);
                    if (p != null)
                    {
                        var v = p.StorageType == StorageType.Double ? p.AsDouble() : 0.0;
                        if (v > 0 && Math.Abs(v - targetFt) <= 1e-5) return true;
                    }
                }

                foreach (var c in MepSystemUtil.GetConnectors(e))
                {
                    if (c == null) continue;
                    if (c.Shape == ConnectorProfileType.Round)
                    {
                        var d = 2.0 * c.Radius;
                        if (Math.Abs(d - targetFt) <= 1e-5) return true;
                    }
                }
            }
            catch { }
            return false;
        }

        private static Parameter? GetRoundDiameterParam(Element e)
        {
            try
            {
                var p = e.get_Parameter(BuiltInParameter.RBS_CURVE_DIAMETER_PARAM);
                if (p != null) return p;
            }
            catch { }

            try { return e.LookupParameter("Diameter") ?? e.LookupParameter("Nominal Diameter"); }
            catch { return null; }
        }
    }
}
