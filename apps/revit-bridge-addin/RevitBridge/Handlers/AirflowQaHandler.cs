using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Text.Json;
using System.Text.RegularExpressions;
using System.Threading.Tasks;
using Autodesk.Revit.DB;
using Autodesk.Revit.DB.Architecture;
using Autodesk.Revit.DB.Mechanical;
using Autodesk.Revit.UI;
using RevitBridge.Common;

namespace RevitBridge.Handlers
{
    public sealed class AirflowQaHandler : IRequestHandler
    {
        public sealed class AirflowRule
        {
            public string designation { get; set; } = "";
            public double minCfm { get; set; }
            public double maxCfm { get; set; }
            public int? rank { get; set; }
        }

        public sealed class SpreadsheetFlowMapping
        {
            public string columnName { get; set; } = "";
            public string roomParameterName { get; set; } = "";
            public string? label { get; set; }
            public double? toleranceCfm { get; set; }
        }

        public sealed class TerminalPlacementSpec
        {
            public string label { get; set; } = "";
            public string? columnName { get; set; }
            public string? familyName { get; set; }
            public string? familyNameContains { get; set; }
            public string? typeName { get; set; }
            public string? typeNameContains { get; set; }
            public string? flowParameterName { get; set; }
            public double? maxCfmPerDevice { get; set; }
            public double? minSeparationFeet { get; set; }
        }

        public sealed class Params
        {
            public string? action { get; set; }
            public bool? dryRun { get; set; }
            public int? max { get; set; }

            public long? viewId { get; set; }
            public string? categoryName { get; set; }
            public string? designationParameterName { get; set; }
            public List<string>? flowParameterNames { get; set; }
            public List<AirflowRule>? rules { get; set; }
            public bool? applyTypeChanges { get; set; }
            public bool? setFlowAfterTypeChange { get; set; }
            public string? setFlowParameterName { get; set; }
            public string? familyNameContains { get; set; }
            public string? typeNameContains { get; set; }
            public bool? includeInRange { get; set; }
            public double? toleranceCfm { get; set; }

            public List<long>? sourceElementIds { get; set; }
            public List<string>? sourceCategories { get; set; }
            public List<string>? sinkCategories { get; set; }
            public string? systemClassification { get; set; }
            public List<string>? scheduledFlowParameterNames { get; set; }
            public List<string>? sinkFlowParameterNames { get; set; }
            public int? maxHops { get; set; }
            public double? mismatchToleranceCfm { get; set; }
            public bool? applyScheduledFlowUpdate { get; set; }
            public string? scheduledFlowWriteParameterName { get; set; }

            public string? sourcePath { get; set; }
            public string? sheetName { get; set; }
            public string? range { get; set; }
            public string? roomNumberColumn { get; set; }
            public List<SpreadsheetFlowMapping>? spreadsheetMappings { get; set; }
            public bool? applyRoomParameterUpdates { get; set; }
            public string? roomSummaryParameterName { get; set; }
            public bool? includePressureClassification { get; set; }
            public string? pressureColumn { get; set; }
            public bool? placeAirTerminalsFromSpreadsheet { get; set; }
            public List<TerminalPlacementSpec>? terminalPlacementSpecs { get; set; }
            public double? maxDeviceCfm { get; set; }
            public double? minDeviceSeparationFeet { get; set; }
            public bool? preferGridIntersections { get; set; }
            public bool? strictGridIntersections { get; set; }
            public double? existingDeviceClearanceFeet { get; set; }
            public List<string>? clashCategoryNames { get; set; }
            public bool? replaceAutoPlacedElements { get; set; }
            public bool? tagPlacedAirTerminals { get; set; }
            public string? tagTypeNameContains { get; set; }
            public bool? onlyTagUntagged { get; set; }
            public bool? addTagLeader { get; set; }
            public double? tagOffsetFeet { get; set; }
            public bool? applyPressureFilledRegions { get; set; }
            public bool? clearPressureRegionsForUnregulated { get; set; }
            public double? pressureFillTransparencyPercent { get; set; }
            public string? positiveColorHex { get; set; }
            public string? negativeColorHex { get; set; }

            public string? baselineModel { get; set; }
            public string? baselineLinkNameContains { get; set; }
            public string? targetModel { get; set; }
            public string? targetLinkNameContains { get; set; }
            public List<string>? outletCategories { get; set; }
            public List<string>? outletTypeParameterNames { get; set; }
            public List<string>? outletIncludeKeywords { get; set; }
        }

        private sealed class FlowReadResult
        {
            public bool ok { get; set; }
            public double cfm { get; set; }
            public string parameterName { get; set; } = "";
            public string parameterScope { get; set; } = "";
            public string raw { get; set; } = "";
        }

        private sealed class SpatialEntry
        {
            public SpatialElement element { get; set; } = null!;
            public string number { get; set; } = "";
            public string normalizedNumber { get; set; } = "";
            public string name { get; set; } = "";
            public string kind { get; set; } = "";
        }

        private sealed class MappingPlan
        {
            public string columnName { get; set; } = "";
            public int columnIndex { get; set; }
            public string roomParameterName { get; set; } = "";
            public string label { get; set; } = "";
            public double? toleranceCfm { get; set; }
        }

        private sealed class TerminalPlacementPlan
        {
            public string label { get; set; } = "";
            public string columnName { get; set; } = "";
            public int columnIndex { get; set; }
            public string? familyName { get; set; }
            public string? familyNameContains { get; set; }
            public string? typeName { get; set; }
            public string? typeNameContains { get; set; }
            public string? flowParameterName { get; set; }
            public double maxCfmPerDevice { get; set; }
            public double minSeparationFeet { get; set; }
        }

        private static readonly string[] DefaultFlowParameterNames =
        {
            "Air Flow", "Flow", "Maximum Air Flow", "Max Air Flow", "Scheduled Max Airflow", "CFM"
        };

        private static readonly string[] DefaultRoomNumberHeaders =
        {
            "Room", "Room Number", "Room No", "Space", "Space Number"
        };

        private static readonly string[] DefaultMedicalGasKeywords =
        {
            "medical", "med gas", "oxygen", "vacuum", "nitrous", "nitrogen", "co2", "medical air", "gas outlet"
        };

        private static readonly string[] DefaultLayoutClashCategories =
        {
            "OST_DuctTerminal",
            "OST_LightingFixtures",
            "OST_LightingDevices",
            "OST_Sprinklers",
            "OST_MechanicalEquipment"
        };

        private static readonly Regex NumberRegex = new Regex(@"[-+]?\d*\.?\d+", RegexOptions.Compiled);

        public Task<object> Handle(UIApplication app, string jsonData)
        {
            var p = string.IsNullOrWhiteSpace(jsonData)
                ? new Params()
                : (JsonSerializer.Deserialize<Params>(jsonData, new JsonSerializerOptions { PropertyNameCaseInsensitive = true }) ?? new Params());

            var uidoc = app.ActiveUIDocument;
            if (uidoc == null) throw new InvalidOperationException("No active Revit document.");
            var doc = uidoc.Document;

            var action = NormalizeAction(p.action);
            return action switch
            {
                "audit_air_devices" => Task.FromResult(AuditAirDevices(doc, p)),
                "audit_connected_flow" => Task.FromResult(AuditConnectedFlow(doc, p)),
                "reconcile_air_balance_sheet" => Task.FromResult(ReconcileAirBalanceSheet(doc, p)),
                "layout_air_terminals_from_sheet" => Task.FromResult(LayoutAirTerminalsFromSheet(doc, p)),
                "tag_airflow_terminals" => Task.FromResult(TagAirflowTerminals(doc, p)),
                "apply_pressure_regions_from_sheet" => Task.FromResult(ApplyPressureRegionsFromSheet(doc, p)),
                "audit_medical_gas_outlets" => Task.FromResult(AuditMedicalGasOutlets(doc, p)),
                _ => throw new InvalidOperationException(
                    "airflow-qa.action must be one of: audit_air_devices, audit_connected_flow, reconcile_air_balance_sheet, layout_air_terminals_from_sheet, tag_airflow_terminals, apply_pressure_regions_from_sheet, audit_medical_gas_outlets.")
            };
        }

        private static object AuditAirDevices(Document doc, Params p)
        {
            var rules = (p.rules ?? new List<AirflowRule>())
                .Where(r => r != null && !string.IsNullOrWhiteSpace(r.designation))
                .Select(r => new AirflowRule
                {
                    designation = (r.designation ?? "").Trim(),
                    minCfm = r.minCfm,
                    maxCfm = r.maxCfm,
                    rank = r.rank
                })
                .Where(r => r.maxCfm >= r.minCfm)
                .OrderBy(r => r.rank ?? int.MaxValue)
                .ThenBy(r => r.minCfm)
                .ToList();

            if (rules.Count == 0)
                throw new InvalidOperationException("audit_air_devices requires non-empty rules with designation/minCfm/maxCfm.");

            var categoryName = (p.categoryName ?? "OST_DuctTerminal").Trim();
            if (!TryResolveCategory(doc, categoryName, out var bic, out var categoryDisplay))
            {
                throw new InvalidOperationException($"Unknown category '{categoryName}'. Use a BuiltInCategory token like OST_DuctTerminal.");
            }

            View? scopeView = null;
            if (p.viewId.HasValue && p.viewId.Value > 0)
            {
                scopeView = doc.GetElement(RevitBridge.Common.ElementIdCompat.Create(p.viewId.Value)) as View;
                if (scopeView == null)
                    throw new InvalidOperationException($"audit_air_devices.viewId {p.viewId.Value} not found.");
            }

            var includeInRange = p.includeInRange ?? false;
            var tolerance = Math.Max(0.0, p.toleranceCfm ?? 0.0);
            var dryRun = p.dryRun ?? false;
            var applyTypeChanges = p.applyTypeChanges == true;
            var setFlowAfterTypeChange = p.setFlowAfterTypeChange == true;
            var designationParamName = (p.designationParameterName ?? "Designation").Trim();
            var flowParamNames = NormalizeStringList(p.flowParameterNames, DefaultFlowParameterNames).ToList();
            var familyNameContains = (p.familyNameContains ?? "").Trim();
            var typeNameContains = (p.typeNameContains ?? "").Trim();
            var limit = ClampInt(p.max ?? 5000, 1, 50000);

            var collector = scopeView != null
                ? new FilteredElementCollector(doc, scopeView.Id)
                : new FilteredElementCollector(doc);

            var elements = collector
                .WhereElementIsNotElementType()
                .OfCategory(bic)
                .Take(limit)
                .ToList();

            var rows = new List<object>();
            var changePlan = new List<(FamilyInstance fi, ElementId targetTypeId, double flowCfm, string? writeParam)>();
            var warnings = new List<string>();

            foreach (var e in elements)
            {
                if (e == null) continue;
                if (!(e is FamilyInstance fi))
                {
                    warnings.Add($"Element {RevitBridge.Common.ElementIdCompat.GetValue(e.Id)} is not a FamilyInstance; skipped.");
                    continue;
                }

                var symbol = fi.Symbol;
                var typeName = symbol?.Name ?? "";
                var familyName = symbol?.FamilyName ?? symbol?.Family?.Name ?? "";

                if (!string.IsNullOrWhiteSpace(familyNameContains) &&
                    familyName.IndexOf(familyNameContains, StringComparison.OrdinalIgnoreCase) < 0)
                    continue;

                if (!string.IsNullOrWhiteSpace(typeNameContains) &&
                    typeName.IndexOf(typeNameContains, StringComparison.OrdinalIgnoreCase) < 0)
                    continue;

                var designation = ReadStringParameterWithTypeFallback(doc, fi, designationParamName)
                    ?? InferDesignationFromTypeName(typeName)
                    ?? "";

                var flowRead = ReadFlowForElement(doc, fi, flowParamNames);
                if (!flowRead.ok)
                {
                    rows.Add(new
                    {
                        elementId = RevitBridge.Common.ElementIdCompat.GetValue(fi.Id),
                        familyName,
                        typeName,
                        designation,
                        status = "missing_flow",
                        message = "No readable airflow parameter found on instance/type.",
                        expectedDesignation = (string?)null,
                        candidateTypeId = (long?)null
                    });
                    continue;
                }

                var expectedRule = FindRuleForFlow(rules, flowRead.cfm, tolerance);
                var currentRule = rules.FirstOrDefault(r => string.Equals(r.designation, designation, StringComparison.OrdinalIgnoreCase));
                var expectedDesignation = expectedRule?.designation ?? "";
                var inRange = expectedRule != null &&
                              currentRule != null &&
                              string.Equals(currentRule.designation, expectedDesignation, StringComparison.OrdinalIgnoreCase);

                if (inRange && !includeInRange)
                    continue;

                long? candidateTypeId = null;
                string? candidateTypeName = null;
                string status;

                if (expectedRule == null)
                {
                    status = "no_matching_rule";
                }
                else if (string.Equals(designation, expectedDesignation, StringComparison.OrdinalIgnoreCase))
                {
                    status = "in_range";
                }
                else
                {
                    status = "mismatch";
                    var candidate = ResolveFamilyTypeForDesignation(doc, fi, designationParamName, expectedDesignation);
                    if (candidate != null)
                    {
                        candidateTypeId = RevitBridge.Common.ElementIdCompat.GetValue(candidate.Id);
                        candidateTypeName = candidate.Name;
                        if (applyTypeChanges)
                        {
                            changePlan.Add((fi, candidate.Id, flowRead.cfm, string.IsNullOrWhiteSpace(p.setFlowParameterName) ? flowRead.parameterName : p.setFlowParameterName));
                        }
                    }
                }

                rows.Add(new
                {
                    elementId = RevitBridge.Common.ElementIdCompat.GetValue(fi.Id),
                    familyName,
                    typeName,
                    designation,
                    flow = new
                    {
                        cfm = flowRead.cfm,
                        parameterName = flowRead.parameterName,
                        parameterScope = flowRead.parameterScope,
                        raw = flowRead.raw
                    },
                    currentRule = currentRule == null ? null : new { currentRule.designation, currentRule.minCfm, currentRule.maxCfm },
                    expectedRule = expectedRule == null ? null : new { expectedRule.designation, expectedRule.minCfm, expectedRule.maxCfm },
                    expectedDesignation = expectedDesignation.Length == 0 ? null : expectedDesignation,
                    status,
                    candidateTypeId,
                    candidateTypeName
                });
            }

            var applied = new List<object>();
            if (applyTypeChanges && !dryRun && changePlan.Count > 0)
            {
                using var t = new Transaction(doc, "Air Device Type Corrections");
                t.Start();
                foreach (var plan in changePlan)
                {
                    try
                    {
                        var beforeTypeId = plan.fi.GetTypeId();
                        plan.fi.ChangeTypeId(plan.targetTypeId);

                        bool flowWriteOk = true;
                        string? flowWriteMessage = null;
                        if (setFlowAfterTypeChange)
                        {
                            flowWriteOk = TrySetFlowOnElement(doc, plan.fi, plan.flowCfm, NormalizeStringList(new[] { plan.writeParam }, DefaultFlowParameterNames), out var flowWriteParam, out var flowWriteScope, out var flowWriteError);
                            flowWriteMessage = flowWriteOk
                                ? (flowWriteParam == null ? "No writable flow parameter found." : $"Flow written via {flowWriteScope}.{flowWriteParam}")
                                : (flowWriteError ?? "Flow write failed.");
                        }

                        applied.Add(new
                        {
                            elementId = RevitBridge.Common.ElementIdCompat.GetValue(plan.fi.Id),
                            beforeTypeId = RevitBridge.Common.ElementIdCompat.GetValue(beforeTypeId),
                            afterTypeId = RevitBridge.Common.ElementIdCompat.GetValue(plan.targetTypeId),
                            flowReapplied = setFlowAfterTypeChange,
                            flowWriteOk,
                            flowWriteMessage
                        });
                    }
                    catch (Exception ex)
                    {
                        applied.Add(new
                        {
                            elementId = RevitBridge.Common.ElementIdCompat.GetValue(plan.fi.Id),
                            beforeTypeId = RevitBridge.Common.ElementIdCompat.GetValue(plan.fi.GetTypeId()),
                            afterTypeId = RevitBridge.Common.ElementIdCompat.GetValue(plan.targetTypeId),
                            error = ex.Message
                        });
                    }
                }
                t.Commit();
            }

            return new
            {
                status = "Ok",
                action = "audit_air_devices",
                dryRun,
                scope = new
                {
                    category = categoryDisplay,
                    viewId = RevitBridge.Common.ElementIdCompat.GetValue(scopeView?.Id),
                    viewName = scopeView?.Name,
                    limit
                },
                summary = new
                {
                    scanned = elements.Count,
                    reported = rows.Count,
                    mismatches = rows.Count(x => HasStatus(x, "mismatch")),
                    missingFlow = rows.Count(x => HasStatus(x, "missing_flow")),
                    noMatchingRule = rows.Count(x => HasStatus(x, "no_matching_rule")),
                    inRange = rows.Count(x => HasStatus(x, "in_range")),
                    typeChangesPlanned = changePlan.Count,
                    typeChangesApplied = applied.Count(x => !HasError(x))
                },
                rules = rules.Select(r => new { r.designation, r.minCfm, r.maxCfm, r.rank }).ToList(),
                results = rows,
                applied,
                warnings
            };
        }

        private static object AuditConnectedFlow(Document doc, Params p)
        {
            var dryRun = p.dryRun ?? false;
            var maxHops = ClampInt(p.maxHops ?? 40, 1, 250);
            var maxSources = ClampInt(p.max ?? 2000, 1, 20000);
            var mismatchTolerance = Math.Max(0.0, p.mismatchToleranceCfm ?? 5.0);
            var applyUpdate = p.applyScheduledFlowUpdate == true;

            var sourceCatsRaw = NormalizeStringList(p.sourceCategories, new[] { "OST_MechanicalEquipment" }).ToList();
            var sinkCatsRaw = NormalizeStringList(p.sinkCategories, new[] { "OST_DuctTerminal" }).ToList();
            var systemClassification = (p.systemClassification ?? "").Trim();

            var sourceBics = ResolveCategoryList(doc, sourceCatsRaw, out var unknownSourceCategories);
            if (sourceBics.Count == 0)
                throw new InvalidOperationException("audit_connected_flow requires at least one valid sourceCategories entry.");

            var sinkBics = ResolveCategoryList(doc, sinkCatsRaw, out var unknownSinkCategories);
            if (sinkBics.Count == 0)
                throw new InvalidOperationException("audit_connected_flow requires at least one valid sinkCategories entry.");

            View? scopeView = null;
            if (p.viewId.HasValue && p.viewId.Value > 0)
            {
                scopeView = doc.GetElement(RevitBridge.Common.ElementIdCompat.Create(p.viewId.Value)) as View;
                if (scopeView == null)
                    throw new InvalidOperationException($"audit_connected_flow.viewId {p.viewId.Value} not found.");
            }

            var scheduledFlowNames = NormalizeStringList(p.scheduledFlowParameterNames, DefaultFlowParameterNames).ToList();
            var sinkFlowNames = NormalizeStringList(p.sinkFlowParameterNames, DefaultFlowParameterNames).ToList();

            var sourceIds = (p.sourceElementIds ?? new List<long>())
                .Where(x => x > 0)
                .Distinct()
                .Take(maxSources)
                .ToList();

            List<Element> sourceElements;
            if (sourceIds.Count > 0)
            {
                sourceElements = sourceIds
                    .Select(id => doc.GetElement(RevitBridge.Common.ElementIdCompat.Create(id)))
                    .Where(e => e != null)
                    .Cast<Element>()
                    .ToList();
            }
            else
            {
                var collector = scopeView != null
                    ? new FilteredElementCollector(doc, scopeView.Id)
                    : new FilteredElementCollector(doc);

                var sourceCatIds = new HashSet<long>(sourceBics.Select(b => (long)(int)b));
                sourceElements = collector
                    .WhereElementIsNotElementType()
                    .Where(e => e?.Category != null && sourceCatIds.Contains(RevitBridge.Common.ElementIdCompat.GetValue(e.Category.Id)))
                    .Take(maxSources)
                    .ToList();
            }

            var sinkCatIdsLong = new HashSet<long>(sinkBics.Select(b => (long)(int)b));
            var warnings = new List<string>();

            if (unknownSourceCategories.Count > 0)
                warnings.Add($"Unknown source categories ignored: {string.Join(", ", unknownSourceCategories)}");
            if (unknownSinkCategories.Count > 0)
                warnings.Add($"Unknown sink categories ignored: {string.Join(", ", unknownSinkCategories)}");

            var results = new List<object>();
            var applyTargets = new List<(Element source, double sinkFlowSum, FlowReadResult scheduledRead)>();

            foreach (var source in sourceElements)
            {
                if (source == null) continue;
                if (!MatchesSystemClassification(source, systemClassification)) continue;

                var scheduled = ReadFlowForElement(doc, source, scheduledFlowNames);
                var networkIds = TraceNetworkElementIds(doc, source, maxHops, 25000);

                var sinkRows = new List<object>();
                var sinkSum = 0.0;
                var missingSinkFlows = 0;

                foreach (var sinkId in networkIds)
                {
                    if (sinkId == RevitBridge.Common.ElementIdCompat.GetValue(source.Id)) continue;
                    var sink = doc.GetElement(RevitBridge.Common.ElementIdCompat.Create(sinkId));
                    if (sink?.Category == null) continue;
                    if (!sinkCatIdsLong.Contains(RevitBridge.Common.ElementIdCompat.GetValue(sink.Category.Id))) continue;
                    if (!MatchesSystemClassification(sink, systemClassification)) continue;

                    var sinkFlow = ReadFlowForElement(doc, sink, sinkFlowNames);
                    if (!sinkFlow.ok)
                    {
                        missingSinkFlows++;
                        sinkRows.Add(new
                        {
                            elementId = RevitBridge.Common.ElementIdCompat.GetValue(sink.Id),
                            category = sink.Category.Name,
                            name = sink.Name,
                            flow = (double?)null,
                            status = "missing_flow"
                        });
                        continue;
                    }

                    sinkSum += sinkFlow.cfm;
                    sinkRows.Add(new
                    {
                        elementId = RevitBridge.Common.ElementIdCompat.GetValue(sink.Id),
                        category = sink.Category.Name,
                        name = sink.Name,
                        flow = sinkFlow.cfm,
                        parameterName = sinkFlow.parameterName,
                        parameterScope = sinkFlow.parameterScope,
                        status = "ok"
                    });
                }

                var delta = scheduled.ok ? scheduled.cfm - sinkSum : (double?)null;
                var mismatch = scheduled.ok ? Math.Abs(delta ?? 0.0) > mismatchTolerance : false;

                if (applyUpdate && !dryRun && scheduled.ok && mismatch)
                {
                    applyTargets.Add((source, sinkSum, scheduled));
                }

                results.Add(new
                {
                    source = new
                    {
                        elementId = RevitBridge.Common.ElementIdCompat.GetValue(source.Id),
                        category = source.Category?.Name,
                        name = source.Name,
                        systemClassification = InferSystemClassificationText(source),
                        scheduledFlow = scheduled.ok ? scheduled.cfm : (double?)null,
                        scheduledFlowParameter = scheduled.ok ? $"{scheduled.parameterScope}.{scheduled.parameterName}" : null,
                        scheduledFlowRaw = scheduled.ok ? scheduled.raw : null
                    },
                    network = new
                    {
                        connectedElementCount = networkIds.Count,
                        sinkCount = sinkRows.Count,
                        missingSinkFlows
                    },
                    sinkFlowSumCfm = sinkSum,
                    deltaCfm = delta,
                    mismatchToleranceCfm = mismatchTolerance,
                    isMismatch = mismatch,
                    sinks = sinkRows
                });
            }

            var applied = new List<object>();
            if (applyUpdate && !dryRun && applyTargets.Count > 0)
            {
                using var t = new Transaction(doc, "Update Scheduled Flows From Connected Sinks");
                t.Start();
                foreach (var target in applyTargets)
                {
                    try
                    {
                        var writeNames = NormalizeStringList(new[]
                        {
                            p.scheduledFlowWriteParameterName,
                            target.scheduledRead.parameterName
                        }, DefaultFlowParameterNames);

                        var ok = TrySetFlowOnElement(doc, target.source, target.sinkFlowSum, writeNames, out var writeParam, out var writeScope, out var err);
                        applied.Add(new
                        {
                            elementId = RevitBridge.Common.ElementIdCompat.GetValue(target.source.Id),
                            targetFlowCfm = target.sinkFlowSum,
                            writeOk = ok,
                            parameter = writeParam == null ? null : $"{writeScope}.{writeParam}",
                            error = ok ? null : err
                        });
                    }
                    catch (Exception ex)
                    {
                        applied.Add(new
                        {
                            elementId = RevitBridge.Common.ElementIdCompat.GetValue(target.source.Id),
                            targetFlowCfm = target.sinkFlowSum,
                            writeOk = false,
                            error = ex.Message
                        });
                    }
                }
                t.Commit();
            }

            return new
            {
                status = "Ok",
                action = "audit_connected_flow",
                dryRun,
                scope = new
                {
                    sourceCount = sourceElements.Count,
                    sourceCategories = sourceBics.Select(x => x.ToString()).ToList(),
                    sinkCategories = sinkBics.Select(x => x.ToString()).ToList(),
                    viewId = RevitBridge.Common.ElementIdCompat.GetValue(scopeView?.Id),
                    viewName = scopeView?.Name,
                    maxHops,
                    mismatchToleranceCfm = mismatchTolerance,
                    systemClassification = string.IsNullOrWhiteSpace(systemClassification) ? null : systemClassification
                },
                summary = new
                {
                    audited = results.Count,
                    mismatches = results.Count(x => HasFlag(x, "isMismatch")),
                    scheduledMissing = results.Count(x => IsScheduledMissing(x)),
                    applyPlanned = applyTargets.Count,
                    applySucceeded = applied.Count(x => !HasError(x))
                },
                results,
                applied,
                warnings
            };
        }

        private static object ReconcileAirBalanceSheet(Document doc, Params p)
        {
            var src = (p.sourcePath ?? "").Trim();
            if (string.IsNullOrWhiteSpace(src)) throw new InvalidOperationException("reconcile_air_balance_sheet.sourcePath is required.");
            var full = WorkspacePaths.ResolveExistingFileUnderWorkspace(src);

            var rangeA1 = (p.range ?? "").Trim();
            if (string.IsNullOrWhiteSpace(rangeA1)) throw new InvalidOperationException("reconcile_air_balance_sheet.range is required (for example A1:K500).");

            var rr = ImportExcelTableHandler.XlsxOpenXml.ReadRange(full, (p.sheetName ?? "").Trim(), rangeA1);
            if (rr.Rows < 2) throw new InvalidOperationException("Spreadsheet range must include a header row and at least one data row.");
            if (rr.Rows > 5000 || rr.Cols > 200) throw new InvalidOperationException("Spreadsheet range too large (max 5000 rows x 200 cols).");

            var dryRun = p.dryRun ?? false;
            var applyRoomUpdates = p.applyRoomParameterUpdates == true;
            var includePressure = p.includePressureClassification ?? true;
            var summaryParam = (p.roomSummaryParameterName ?? "").Trim();
            var maxRows = ClampInt(p.max ?? rr.Rows - 1, 1, rr.Rows - 1);

            var headerRow = rr.Grid[0].Select(x => (x ?? "").Trim()).ToList();
            var headerIndex = BuildHeaderIndex(headerRow);

            var roomColInput = (p.roomNumberColumn ?? "").Trim();
            var roomColIndex = ResolveHeaderIndex(headerIndex, roomColInput, DefaultRoomNumberHeaders);
            if (roomColIndex < 0)
            {
                throw new InvalidOperationException("Could not resolve room number column. Provide roomNumberColumn or include a standard header like 'Room Number'.");
            }

            var mappings = BuildSpreadsheetMappings(p.spreadsheetMappings, headerIndex);
            if (mappings.Count == 0)
            {
                throw new InvalidOperationException(
                    "No usable spreadsheetMappings found. Provide mappings, or include default headers like 'Supply CFM', 'Return CFM', or 'Exhaust CFM'.");
            }

            var pressureHeader = (p.pressureColumn ?? "").Trim();
            var pressureColIndex = includePressure ? ResolveHeaderIndex(headerIndex, pressureHeader, new[] { "Pressure", "Pressurization", "Room Pressure" }) : -1;

            var roomIndex = BuildSpatialIndexByNumber(doc, preferRooms: true);
            var warnings = new List<string>();
            var rows = new List<object>();
            var updates = new List<object>();

            var shouldWrite = (applyRoomUpdates || !string.IsNullOrWhiteSpace(summaryParam)) && !dryRun;

            Action processRows = () =>
            {
                for (int r = 1; r < rr.Rows && rows.Count < maxRows; r++)
                {
                    var row = rr.Grid[r];
                    var roomRaw = SafeCell(row, roomColIndex).Trim();
                    if (string.IsNullOrWhiteSpace(roomRaw)) continue;

                    var roomNorm = NormalizeRoomNumber(roomRaw);
                    if (!roomIndex.TryGetValue(roomNorm, out var spatial) || spatial == null)
                    {
                        rows.Add(new
                        {
                            row = r + 1,
                            room = roomRaw,
                            status = "room_not_found",
                            checks = new object[0]
                        });
                        continue;
                    }

                    var checks = new List<object>();
                    var summaryParts = new List<string>();
                    var mismatchCount = 0;
                    var updateCount = 0;

                    foreach (var m in mappings)
                    {
                        var expectedRaw = SafeCell(row, m.columnIndex).Trim();
                        if (!TryExtractFirstNumber(expectedRaw, out var expectedCfm))
                        {
                            checks.Add(new
                            {
                                label = m.label,
                                column = m.columnName,
                                roomParameter = m.roomParameterName,
                                expectedCfm = (double?)null,
                                actualCfm = (double?)null,
                                status = "missing_expected"
                            });
                            continue;
                        }

                        var actualRead = ReadFlowForElement(doc, spatial.element, new[] { m.roomParameterName });
                        var actual = actualRead.ok ? actualRead.cfm : double.NaN;
                        var tol = Math.Max(0.0, m.toleranceCfm ?? 5.0);
                        var isMismatch = !actualRead.ok || Math.Abs(actual - expectedCfm) > tol;
                        if (isMismatch) mismatchCount++;

                        var writeOk = false;
                        string? writeError = null;
                        if (applyRoomUpdates && isMismatch)
                        {
                            writeOk = TrySetFlowOnElement(doc, spatial.element, expectedCfm, new[] { m.roomParameterName }, out var _, out var _, out writeError);
                            if (writeOk) updateCount++;
                        }

                        checks.Add(new
                        {
                            label = m.label,
                            column = m.columnName,
                            roomParameter = m.roomParameterName,
                            expectedCfm,
                            actualCfm = actualRead.ok ? actual : (double?)null,
                            toleranceCfm = tol,
                            isMismatch,
                            writeOk = applyRoomUpdates ? (bool?)writeOk : null,
                            writeError = applyRoomUpdates && !writeOk && isMismatch ? writeError : null
                        });

                        summaryParts.Add($"{m.label}:{Math.Round(expectedCfm, 1).ToString(CultureInfo.InvariantCulture)} CFM");

                        if (applyRoomUpdates)
                        {
                            updates.Add(new
                            {
                                row = r + 1,
                                room = roomRaw,
                                parameter = m.roomParameterName,
                                expectedCfm,
                                writeOk,
                                writeError
                            });
                        }
                    }

                    string? pressureRaw = null;
                    string? pressureClass = null;
                    string? pressureColor = null;
                    if (includePressure && pressureColIndex >= 0)
                    {
                        pressureRaw = SafeCell(row, pressureColIndex).Trim();
                        pressureClass = ClassifyPressureText(pressureRaw);
                        pressureColor = pressureClass switch
                        {
                            "positive" => "green_20pct",
                            "negative" => "red_20pct",
                            _ => null
                        };

                        if (!string.IsNullOrWhiteSpace(pressureRaw))
                            summaryParts.Add($"Pressure:{pressureRaw}");
                    }

                    string? summaryText = null;
                    if (summaryParts.Count > 0)
                    {
                        summaryText = string.Join(" | ", summaryParts);
                        if (!string.IsNullOrWhiteSpace(summaryParam))
                        {
                            var ok = TrySetStringOnElement(spatial.element, summaryParam, summaryText, out var err);
                            updates.Add(new
                            {
                                row = r + 1,
                                room = roomRaw,
                                parameter = summaryParam,
                                text = summaryText,
                                writeOk = ok,
                                writeError = ok ? null : err
                            });
                        }
                    }

                    rows.Add(new
                    {
                        row = r + 1,
                        room = roomRaw,
                        roomId = RevitBridge.Common.ElementIdCompat.GetValue(spatial.element.Id),
                        roomName = spatial.name,
                        roomKind = spatial.kind,
                        status = mismatchCount > 0 ? "mismatch" : "ok",
                        mismatchCount,
                        updatesApplied = updateCount,
                        pressure = includePressure ? new { raw = pressureRaw, classification = pressureClass, recommendedColor = pressureColor } : null,
                        summaryText,
                        checks
                    });
                }
            };

            if (shouldWrite)
            {
                using var t = new Transaction(doc, "Reconcile Air Balance Spreadsheet");
                t.Start();
                processRows();
                t.Commit();
            }
            else
            {
                if (dryRun && (applyRoomUpdates || !string.IsNullOrWhiteSpace(summaryParam)))
                {
                    using var t = new Transaction(doc, "Reconcile Air Balance Spreadsheet (Dry Run)");
                    t.Start();
                    processRows();
                    t.RollBack();
                }
                else
                {
                    processRows();
                }
            }

            if (pressureColIndex < 0 && includePressure)
            {
                warnings.Add("Pressure column not found; pressure classification was skipped.");
            }

            return new
            {
                status = "Ok",
                action = "reconcile_air_balance_sheet",
                dryRun,
                sourcePath = src,
                sheetName = rr.SheetName,
                range = rangeA1,
                summary = new
                {
                    rowsProcessed = rows.Count,
                    mismatchedRooms = rows.Count(x => HasStatus(x, "mismatch")),
                    roomNotFound = rows.Count(x => HasStatus(x, "room_not_found")),
                    mappings = mappings.Count,
                    updatesAttempted = updates.Count,
                    updatesSucceeded = updates.Count(x => !HasError(x))
                },
                mappings = mappings.Select(m => new { m.columnName, m.roomParameterName, m.label, m.toleranceCfm }).ToList(),
                results = rows,
                updates,
                warnings
            };
        }

        private static object LayoutAirTerminalsFromSheet(Document doc, Params p)
        {
            var src = (p.sourcePath ?? "").Trim();
            if (string.IsNullOrWhiteSpace(src)) throw new InvalidOperationException("layout_air_terminals_from_sheet.sourcePath is required.");
            var full = WorkspacePaths.ResolveExistingFileUnderWorkspace(src);

            var rangeA1 = (p.range ?? "").Trim();
            if (string.IsNullOrWhiteSpace(rangeA1)) throw new InvalidOperationException("layout_air_terminals_from_sheet.range is required (for example A1:H500).");

            var rr = ImportExcelTableHandler.XlsxOpenXml.ReadRange(full, (p.sheetName ?? "").Trim(), rangeA1);
            if (rr.Rows < 2) throw new InvalidOperationException("Spreadsheet range must include a header row and at least one data row.");
            if (rr.Rows > 5000 || rr.Cols > 200) throw new InvalidOperationException("Spreadsheet range too large (max 5000 rows x 200 cols).");

            var headerRow = rr.Grid[0].Select(x => (x ?? "").Trim()).ToList();
            var headerIndex = BuildHeaderIndex(headerRow);

            var roomColInput = (p.roomNumberColumn ?? "").Trim();
            var roomColIndex = ResolveHeaderIndex(headerIndex, roomColInput, DefaultRoomNumberHeaders);
            if (roomColIndex < 0)
                throw new InvalidOperationException("Could not resolve room number column. Provide roomNumberColumn or include a standard header like 'Room Number'.");

            var placementPlans = BuildTerminalPlacementPlans(p.terminalPlacementSpecs, headerIndex, p.maxDeviceCfm, p.minDeviceSeparationFeet);
            if (placementPlans.Count == 0)
                throw new InvalidOperationException("No usable terminalPlacementSpecs found. Provide label+columnName and optional family/type selectors.");

            View? scopeView = null;
            if (p.viewId.HasValue && p.viewId.Value > 0)
            {
                scopeView = doc.GetElement(RevitBridge.Common.ElementIdCompat.Create(p.viewId.Value)) as View;
                if (scopeView == null) throw new InvalidOperationException($"layout_air_terminals_from_sheet.viewId {p.viewId.Value} not found.");
            }
            scopeView ??= doc.ActiveView;

            var roomIndex = BuildSpatialIndexByNumber(doc, preferRooms: true);
            var dryRun = p.dryRun ?? false;
            var replaceAuto = p.replaceAutoPlacedElements ?? true;
            var tagPlaced = p.tagPlacedAirTerminals ?? false;
            var onlyTagUntagged = p.onlyTagUntagged ?? true;
            var addLeader = p.addTagLeader ?? false;
            var tagOffsetFt = Math.Max(0.1, p.tagOffsetFeet ?? 1.0);
            var warnings = new List<string>();
            var preferGridIntersections = p.preferGridIntersections ?? true;
            var strictGridIntersections = p.strictGridIntersections ?? false;
            var existingDeviceClearanceFeet = Math.Max(0.1, p.existingDeviceClearanceFeet ?? Math.Max(0.5, (p.minDeviceSeparationFeet ?? 3.0) * 0.35));
            var clashCategoryBics = ResolveLayoutClashCategories(doc, p.clashCategoryNames, warnings);
            var maxRows = ClampInt(p.max ?? rr.Rows - 1, 1, rr.Rows - 1);

            var rows = new List<object>();
            var placedRows = new List<object>();
            var placedIds = new List<long>();

            Action process = () =>
            {
                for (int r = 1; r < rr.Rows && rows.Count < maxRows; r++)
                {
                    var row = rr.Grid[r];
                    var roomRaw = SafeCell(row, roomColIndex).Trim();
                    if (roomRaw.Length == 0) continue;

                    var roomNorm = NormalizeRoomNumber(roomRaw);
                    if (!roomIndex.TryGetValue(roomNorm, out var spatial) || spatial == null)
                    {
                        rows.Add(new { row = r + 1, room = roomRaw, status = "room_not_found", placements = Array.Empty<object>() });
                        continue;
                    }

                    var perRoom = new List<object>();
                    var roomPlaced = 0;
                    foreach (var plan in placementPlans)
                    {
                        var raw = SafeCell(row, plan.columnIndex).Trim();
                        if (!TryExtractFirstNumber(raw, out var totalCfm) || totalCfm <= 0)
                        {
                            perRoom.Add(new
                            {
                                label = plan.label,
                                column = plan.columnName,
                                expectedCfm = (double?)null,
                                status = "missing_or_zero_flow",
                                placedCount = 0
                            });
                            continue;
                        }

                        var symbol = ResolveTerminalSymbol(doc, plan, out var symbolMsg);
                        if (symbol == null)
                        {
                            perRoom.Add(new
                            {
                                label = plan.label,
                                column = plan.columnName,
                                expectedCfm = totalCfm,
                                status = "symbol_not_found",
                                message = symbolMsg,
                                placedCount = 0
                            });
                            continue;
                        }

                        var markerPrefix = BuildTerminalMarkerPrefix(RevitBridge.Common.ElementIdCompat.GetValue(spatial.element.Id), plan.label);
                        var removed = 0;
                        if (replaceAuto)
                        {
                            removed = RemoveAutoPlacedTerminals(doc, markerPrefix);
                        }

                        var count = Math.Max(1, (int)Math.Ceiling(totalCfm / Math.Max(1.0, plan.maxCfmPerDevice)));
                        var perDeviceCfm = totalCfm / count;
                        var existingDevicePoints = CollectExistingDevicePointsInSpatial(doc, scopeView, spatial.element, clashCategoryBics);
                        var points = ComputeDistributedPointsForSpatial(
                            doc,
                            spatial.element,
                            count,
                            plan.minSeparationFeet,
                            scopeView,
                            preferGridIntersections,
                            strictGridIntersections,
                            existingDevicePoints,
                            existingDeviceClearanceFeet);
                        if (points.Count < count)
                        {
                            warnings.Add($"Room {roomRaw} label {plan.label}: found {points.Count} valid point(s) for requested count {count}; using fallback room center points for the remainder.");
                            var fallback = ResolveElementLocationPoint(spatial.element) ?? XYZ.Zero;
                            while (points.Count < count) points.Add(fallback);
                        }

                        var placedForSpec = 0;
                        var errors = new List<string>();
                        for (int i = 0; i < count; i++)
                        {
                            var point = points[i];
                            if (dryRun)
                            {
                                placedForSpec++;
                                placedRows.Add(new
                                {
                                    row = r + 1,
                                    room = roomRaw,
                                    roomId = RevitBridge.Common.ElementIdCompat.GetValue(spatial.element.Id),
                                    label = plan.label,
                                    point = new[] { point.X, point.Y, point.Z },
                                    family = symbol.FamilyName,
                                    type = symbol.Name,
                                    flowCfm = perDeviceCfm,
                                    status = "planned"
                                });
                                continue;
                            }

                            if (!TryCreateFamilyInstance(doc, symbol, point, ResolveSpatialLevel(doc, spatial.element), out var fi, out var createErr) || fi == null)
                            {
                                errors.Add(createErr ?? "Failed to create family instance.");
                                continue;
                            }

                            TrySetStringOnElement(fi, "Comments", $"{markerPrefix}:{i + 1}", out _);
                            var writeNames = NormalizeStringList(new[] { plan.flowParameterName }, DefaultFlowParameterNames);
                            TrySetFlowOnElement(doc, fi, perDeviceCfm, writeNames, out var flowParam, out var flowScope, out var flowErr);

                            placedIds.Add(RevitBridge.Common.ElementIdCompat.GetValue(fi.Id));
                            placedForSpec++;
                            placedRows.Add(new
                            {
                                row = r + 1,
                                room = roomRaw,
                                roomId = RevitBridge.Common.ElementIdCompat.GetValue(spatial.element.Id),
                                label = plan.label,
                                elementId = RevitBridge.Common.ElementIdCompat.GetValue(fi.Id),
                                family = fi.Symbol?.FamilyName,
                                type = fi.Symbol?.Name,
                                flowCfm = perDeviceCfm,
                                flowWriteParameter = flowParam == null ? null : $"{flowScope}.{flowParam}",
                                flowWriteError = flowErr
                            });
                        }

                        roomPlaced += placedForSpec;
                        perRoom.Add(new
                        {
                            label = plan.label,
                            column = plan.columnName,
                            expectedCfm = totalCfm,
                            countPlanned = count,
                            perDeviceCfm,
                            maxCfmPerDevice = plan.maxCfmPerDevice,
                            removedAutoPlaced = removed,
                            preferredGridIntersections = preferGridIntersections,
                            strictGridIntersections,
                            clashCategoryCount = clashCategoryBics.Count,
                            existingDeviceClearanceFeet,
                            placedCount = placedForSpec,
                            status = errors.Count == 0 ? "ok" : "partial",
                            errors
                        });
                    }

                    rows.Add(new
                    {
                        row = r + 1,
                        room = roomRaw,
                        roomId = RevitBridge.Common.ElementIdCompat.GetValue(spatial.element.Id),
                        roomName = spatial.name,
                        roomKind = spatial.kind,
                        status = roomPlaced > 0 ? "ok" : "no_placements",
                        placedCount = roomPlaced,
                        placements = perRoom
                    });
                }
            };

            if (dryRun)
            {
                using var t = new Transaction(doc, "Layout Air Terminals From Sheet (Dry Run)");
                t.Start();
                process();
                t.RollBack();
            }
            else
            {
                using var t = new Transaction(doc, "Layout Air Terminals From Sheet");
                t.Start();
                process();
                t.Commit();
            }

            var tagResult = (object?)null;
            if (tagPlaced && scopeView != null && placedIds.Count > 0)
            {
                tagResult = TagElementsInView(doc, scopeView, placedIds, p.tagTypeNameContains, onlyTagUntagged, addLeader, tagOffsetFt, dryRun);
            }

            return new
            {
                status = "Ok",
                action = "layout_air_terminals_from_sheet",
                dryRun,
                sourcePath = src,
                sheetName = rr.SheetName,
                range = rangeA1,
                viewId = RevitBridge.Common.ElementIdCompat.GetValue(scopeView?.Id),
                layoutHeuristics = new
                {
                    preferGridIntersections,
                    strictGridIntersections,
                    existingDeviceClearanceFeet,
                    clashCategories = clashCategoryBics.Select(x => x.ToString()).ToList()
                },
                summary = new
                {
                    rowsProcessed = rows.Count,
                    roomNotFound = rows.Count(x => HasStatus(x, "room_not_found")),
                    placementsPlannedOrApplied = placedRows.Count,
                    placedElements = placedIds.Count,
                    taggingAttempted = tagPlaced && placedIds.Count > 0
                },
                placementSpecs = placementPlans.Select(x => new
                {
                    x.label,
                    x.columnName,
                    x.familyName,
                    x.familyNameContains,
                    x.typeName,
                    x.typeNameContains,
                    x.maxCfmPerDevice,
                    x.minSeparationFeet,
                    x.flowParameterName
                }).ToList(),
                results = rows,
                placed = placedRows,
                tagging = tagResult,
                warnings
            };
        }

        private static object TagAirflowTerminals(Document doc, Params p)
        {
            var dryRun = p.dryRun ?? false;
            var onlyUntagged = p.onlyTagUntagged ?? true;
            var addLeader = p.addTagLeader ?? false;
            var offsetFt = Math.Max(0.1, p.tagOffsetFeet ?? 1.0);
            var limit = ClampInt(p.max ?? 5000, 1, 50000);

            View? scopeView = null;
            if (p.viewId.HasValue && p.viewId.Value > 0)
            {
                scopeView = doc.GetElement(RevitBridge.Common.ElementIdCompat.Create(p.viewId.Value)) as View;
                if (scopeView == null) throw new InvalidOperationException($"tag_airflow_terminals.viewId {p.viewId.Value} not found.");
            }
            scopeView ??= doc.ActiveView;
            if (scopeView == null) throw new InvalidOperationException("No active view available for tag_airflow_terminals.");

            var targetIds = new List<long>();
            if (p.sourceElementIds != null && p.sourceElementIds.Count > 0)
            {
                targetIds = p.sourceElementIds.Where(x => x > 0).Distinct().Take(limit).ToList();
            }
            else
            {
                targetIds = new FilteredElementCollector(doc, scopeView.Id)
                    .WhereElementIsNotElementType()
                    .OfCategory(BuiltInCategory.OST_DuctTerminal)
                    .Take(limit)
                    .Select(x => RevitBridge.Common.ElementIdCompat.GetValue(x.Id))
                    .ToList();
            }

            var tagResult = TagElementsInView(doc, scopeView, targetIds, p.tagTypeNameContains, onlyUntagged, addLeader, offsetFt, dryRun);
            return new
            {
                status = "Ok",
                action = "tag_airflow_terminals",
                dryRun,
                viewId = RevitBridge.Common.ElementIdCompat.GetValue(scopeView.Id),
                summary = new
                {
                    candidates = targetIds.Count,
                    tagged = ReadIntProperty(tagResult, "tagged"),
                    skippedAlreadyTagged = ReadIntProperty(tagResult, "skippedAlreadyTagged"),
                    failed = ReadIntProperty(tagResult, "failed")
                },
                result = tagResult
            };
        }

        private static object ApplyPressureRegionsFromSheet(Document doc, Params p)
        {
            var src = (p.sourcePath ?? "").Trim();
            if (string.IsNullOrWhiteSpace(src)) throw new InvalidOperationException("apply_pressure_regions_from_sheet.sourcePath is required.");
            var full = WorkspacePaths.ResolveExistingFileUnderWorkspace(src);

            var rangeA1 = (p.range ?? "").Trim();
            if (string.IsNullOrWhiteSpace(rangeA1)) throw new InvalidOperationException("apply_pressure_regions_from_sheet.range is required (for example A1:H500).");

            var rr = ImportExcelTableHandler.XlsxOpenXml.ReadRange(full, (p.sheetName ?? "").Trim(), rangeA1);
            if (rr.Rows < 2) throw new InvalidOperationException("Spreadsheet range must include a header row and at least one data row.");
            if (rr.Rows > 5000 || rr.Cols > 200) throw new InvalidOperationException("Spreadsheet range too large (max 5000 rows x 200 cols).");

            View? view = null;
            if (p.viewId.HasValue && p.viewId.Value > 0)
            {
                view = doc.GetElement(RevitBridge.Common.ElementIdCompat.Create(p.viewId.Value)) as View;
                if (view == null) throw new InvalidOperationException($"apply_pressure_regions_from_sheet.viewId {p.viewId.Value} not found.");
            }
            view ??= doc.ActiveView;
            if (view == null) throw new InvalidOperationException("No active view available for apply_pressure_regions_from_sheet.");

            var headerRow = rr.Grid[0].Select(x => (x ?? "").Trim()).ToList();
            var headerIndex = BuildHeaderIndex(headerRow);

            var roomColInput = (p.roomNumberColumn ?? "").Trim();
            var roomColIndex = ResolveHeaderIndex(headerIndex, roomColInput, DefaultRoomNumberHeaders);
            if (roomColIndex < 0)
                throw new InvalidOperationException("Could not resolve room number column. Provide roomNumberColumn or include a standard header like 'Room Number'.");

            var pressureHeader = (p.pressureColumn ?? "").Trim();
            var pressureColIndex = ResolveHeaderIndex(headerIndex, pressureHeader, new[] { "Pressure", "Pressurization", "Room Pressure" });
            if (pressureColIndex < 0)
                throw new InvalidOperationException("Could not resolve pressure column. Provide pressureColumn or include a standard header like 'Pressure'.");

            var roomIndex = BuildSpatialIndexByNumber(doc, preferRooms: true);
            var dryRun = p.dryRun ?? false;
            var clearUnregulated = p.clearPressureRegionsForUnregulated ?? true;
            var replaceAuto = p.replaceAutoPlacedElements ?? true;
            var maxRows = ClampInt(p.max ?? rr.Rows - 1, 1, rr.Rows - 1);
            var transparency = ClampInt((int)Math.Round(Math.Max(0.0, Math.Min(100.0, p.pressureFillTransparencyPercent ?? 20.0))), 0, 100);
            var positiveColor = ParseHexColorOrDefault(p.positiveColorHex, new Color(0, 180, 0));
            var negativeColor = ParseHexColorOrDefault(p.negativeColorHex, new Color(210, 40, 40));
            var solidPatternId = ResolveSolidFillPatternId(doc);
            if (solidPatternId == ElementId.InvalidElementId)
                throw new InvalidOperationException("Could not resolve a solid fill pattern for pressure region graphics.");

            var warnings = new List<string>();
            var created = new List<object>();
            var cleared = new List<object>();
            var rows = new List<object>();

            Action process = () =>
            {
                for (int r = 1; r < rr.Rows && rows.Count < maxRows; r++)
                {
                    var row = rr.Grid[r];
                    var roomRaw = SafeCell(row, roomColIndex).Trim();
                    if (roomRaw.Length == 0) continue;

                    var roomNorm = NormalizeRoomNumber(roomRaw);
                    if (!roomIndex.TryGetValue(roomNorm, out var spatial) || spatial == null)
                    {
                        rows.Add(new { row = r + 1, room = roomRaw, status = "room_not_found" });
                        continue;
                    }

                    var pressureRaw = SafeCell(row, pressureColIndex).Trim();
                    var pressureClass = ClassifyPressureText(pressureRaw);
                    var markerPrefix = BuildPressureMarkerPrefix(RevitBridge.Common.ElementIdCompat.GetValue(spatial.element.Id));

                    if (replaceAuto && (pressureClass != "unregulated" || clearUnregulated))
                    {
                        var removed = RemoveAutoPressureRegions(doc, view, markerPrefix);
                        if (removed.Count > 0) cleared.AddRange(removed);
                    }

                    if (pressureClass == "unregulated")
                    {
                        rows.Add(new
                        {
                            row = r + 1,
                            room = roomRaw,
                            roomId = RevitBridge.Common.ElementIdCompat.GetValue(spatial.element.Id),
                            pressure = pressureRaw,
                            classification = pressureClass,
                            status = clearUnregulated ? "cleared_or_none" : "skipped_unregulated"
                        });
                        continue;
                    }

                    if (!TryBuildSpatialBoundaryLoops(spatial.element, out var loops, out var boundaryWarning))
                    {
                        warnings.Add($"Room {roomRaw}: {boundaryWarning ?? "Boundary loops unavailable; skipped pressure region."}");
                        rows.Add(new
                        {
                            row = r + 1,
                            room = roomRaw,
                            roomId = RevitBridge.Common.ElementIdCompat.GetValue(spatial.element.Id),
                            pressure = pressureRaw,
                            classification = pressureClass,
                            status = "boundary_missing"
                        });
                        continue;
                    }

                    var color = pressureClass == "positive" ? positiveColor : negativeColor;
                    FilledRegion? fr = null;
                    string? createErr = null;
                    if (!dryRun)
                    {
                        try
                        {
                            var typeId = new FilteredElementCollector(doc).OfClass(typeof(FilledRegionType)).FirstElementId();
                            fr = FilledRegion.Create(doc, typeId, view.Id, loops);
                            TrySetStringOnElement(fr, "Comments", $"{markerPrefix}:{pressureClass}", out _);

                            var ogs = new OverrideGraphicSettings();
                            ogs.SetSurfaceForegroundPatternId(solidPatternId);
                            ogs.SetSurfaceForegroundPatternColor(color);
                            ogs.SetSurfaceTransparency(transparency);
                            view.SetElementOverrides(fr.Id, ogs);
                        }
                        catch (Exception ex)
                        {
                            createErr = ex.Message;
                        }
                    }

                    rows.Add(new
                    {
                        row = r + 1,
                        room = roomRaw,
                        roomId = RevitBridge.Common.ElementIdCompat.GetValue(spatial.element.Id),
                        pressure = pressureRaw,
                        classification = pressureClass,
                        status = createErr == null ? (dryRun ? "planned" : "created") : "failed",
                        regionId = RevitBridge.Common.ElementIdCompat.GetValue(fr?.Id),
                        error = createErr
                    });

                    if (createErr == null)
                    {
                        created.Add(new
                        {
                            row = r + 1,
                            room = roomRaw,
                            roomId = RevitBridge.Common.ElementIdCompat.GetValue(spatial.element.Id),
                            classification = pressureClass,
                            regionId = RevitBridge.Common.ElementIdCompat.GetValue(fr?.Id),
                            color = ColorToHex(color),
                            transparency
                        });
                    }
                }
            };

            if (dryRun)
            {
                using var t = new Transaction(doc, "Apply Pressure Regions From Sheet (Dry Run)");
                t.Start();
                process();
                t.RollBack();
            }
            else
            {
                using var t = new Transaction(doc, "Apply Pressure Regions From Sheet");
                t.Start();
                process();
                t.Commit();
            }

            return new
            {
                status = "Ok",
                action = "apply_pressure_regions_from_sheet",
                dryRun,
                sourcePath = src,
                sheetName = rr.SheetName,
                range = rangeA1,
                viewId = RevitBridge.Common.ElementIdCompat.GetValue(view.Id),
                summary = new
                {
                    rowsProcessed = rows.Count,
                    created = created.Count,
                    cleared = cleared.Count,
                    roomNotFound = rows.Count(x => HasStatus(x, "room_not_found")),
                    boundaryMissing = rows.Count(x => HasStatus(x, "boundary_missing"))
                },
                created,
                cleared,
                results = rows,
                warnings
            };
        }

        private static object AuditMedicalGasOutlets(Document hostDoc, Params p)
        {
            var baselineMode = NormalizeModelMode(p.baselineModel, "link");
            var targetMode = NormalizeModelMode(p.targetModel, "host");

            var baselineDoc = ResolveModelDoc(hostDoc, baselineMode, (p.baselineLinkNameContains ?? "").Trim(), out var baselineLabel);
            var targetDoc = ResolveModelDoc(hostDoc, targetMode, (p.targetLinkNameContains ?? "").Trim(), out var targetLabel);

            if (baselineDoc == null)
                throw new InvalidOperationException("Could not resolve baseline model document. Provide baselineModel/baselineLinkNameContains.");
            if (targetDoc == null)
                throw new InvalidOperationException("Could not resolve target model document. Provide targetModel/targetLinkNameContains.");

            var outletCategories = NormalizeStringList(p.outletCategories, new[]
            {
                "OST_PlumbingFixtures",
                "OST_MechanicalEquipment",
                "OST_GenericModel"
            }).ToList();
            var typeParamNames = NormalizeStringList(p.outletTypeParameterNames, new[]
            {
                "Outlet Type",
                "Medical Gas Type",
                "Type Mark",
                "System Type",
                "Comments"
            }).ToList();

            var includeKeywords = NormalizeStringList(p.outletIncludeKeywords, DefaultMedicalGasKeywords)
                .Select(x => x.Trim())
                .Where(x => x.Length > 0)
                .Distinct(StringComparer.OrdinalIgnoreCase)
                .ToList();

            var baselineCounts = CollectMedicalGasCountsByRoom(baselineDoc, outletCategories, typeParamNames, includeKeywords, out var baselineWarnings);
            var targetCounts = CollectMedicalGasCountsByRoom(targetDoc, outletCategories, typeParamNames, includeKeywords, out var targetWarnings);

            var roomKeys = new HashSet<string>(baselineCounts.Keys, StringComparer.OrdinalIgnoreCase);
            roomKeys.UnionWith(targetCounts.Keys);

            var mismatches = new List<object>();

            foreach (var room in roomKeys.OrderBy(x => x, StringComparer.OrdinalIgnoreCase))
            {
                baselineCounts.TryGetValue(room, out var baseByType);
                targetCounts.TryGetValue(room, out var targetByType);

                baseByType ??= new Dictionary<string, int>(StringComparer.OrdinalIgnoreCase);
                targetByType ??= new Dictionary<string, int>(StringComparer.OrdinalIgnoreCase);

                var typeKeys = new HashSet<string>(baseByType.Keys, StringComparer.OrdinalIgnoreCase);
                typeKeys.UnionWith(targetByType.Keys);

                var rowDiffs = new List<object>();
                foreach (var tk in typeKeys.OrderBy(x => x, StringComparer.OrdinalIgnoreCase))
                {
                    var b = baseByType.TryGetValue(tk, out var bv) ? bv : 0;
                    var t = targetByType.TryGetValue(tk, out var tv) ? tv : 0;
                    if (b == t) continue;

                    rowDiffs.Add(new
                    {
                        outletType = tk,
                        baselineCount = b,
                        targetCount = t,
                        delta = t - b
                    });
                }

                if (rowDiffs.Count == 0) continue;

                mismatches.Add(new
                {
                    roomNumber = room,
                    baselineTotal = baseByType.Values.Sum(),
                    targetTotal = targetByType.Values.Sum(),
                    differences = rowDiffs
                });
            }

            var warnings = new List<string>();
            warnings.AddRange(baselineWarnings);
            warnings.AddRange(targetWarnings);

            return new
            {
                status = "Ok",
                action = "audit_medical_gas_outlets",
                baseline = baselineLabel,
                target = targetLabel,
                summary = new
                {
                    baselineRooms = baselineCounts.Count,
                    targetRooms = targetCounts.Count,
                    mismatchedRooms = mismatches.Count
                },
                mismatches,
                warnings
            };
        }

        private static Dictionary<string, Dictionary<string, int>> CollectMedicalGasCountsByRoom(
            Document doc,
            List<string> categoryNames,
            List<string> typeParameterNames,
            List<string> includeKeywords,
            out List<string> warnings)
        {
            warnings = new List<string>();
            var bics = ResolveCategoryList(doc, categoryNames, out var unknown);
            if (unknown.Count > 0) warnings.Add($"Unknown outlet categories in {doc.Title}: {string.Join(", ", unknown)}");

            var catIds = new HashSet<long>(bics.Select(x => (long)(int)x));
            var rooms = BuildSpatialList(doc, preferRooms: true);

            var map = new Dictionary<string, Dictionary<string, int>>(StringComparer.OrdinalIgnoreCase);

            foreach (var e in new FilteredElementCollector(doc).WhereElementIsNotElementType())
            {
                if (e?.Category == null) continue;
                if (!catIds.Contains(RevitBridge.Common.ElementIdCompat.GetValue(e.Category.Id))) continue;

                var token = ResolveOutletTypeToken(doc, e, typeParameterNames);
                var typeSearchText = BuildOutletSearchText(doc, e, token);
                if (!MatchesAnyKeyword(typeSearchText, includeKeywords)) continue;

                var roomNumber = ResolveElementRoomNumber(doc, e, rooms) ?? "";
                if (string.IsNullOrWhiteSpace(roomNumber)) continue;

                if (!map.TryGetValue(roomNumber, out var byType))
                {
                    byType = new Dictionary<string, int>(StringComparer.OrdinalIgnoreCase);
                    map[roomNumber] = byType;
                }

                var key = string.IsNullOrWhiteSpace(token) ? "(unknown)" : token;
                if (byType.TryGetValue(key, out var cur)) byType[key] = cur + 1;
                else byType[key] = 1;
            }

            return map;
        }

        private static string ResolveOutletTypeToken(Document doc, Element e, List<string> parameterNames)
        {
            foreach (var name in parameterNames)
            {
                var s = ReadStringParameterWithTypeFallback(doc, e, name);
                if (!string.IsNullOrWhiteSpace(s)) return (s ?? "").Trim();
            }

            var type = doc.GetElement(e.GetTypeId()) as ElementType;
            if (type != null)
            {
                var family = (type as FamilySymbol)?.FamilyName ?? (type as FamilySymbol)?.Family?.Name ?? "";
                var tname = type.Name ?? "";
                var combined = string.Join(" - ", new[] { family, tname }.Where(x => !string.IsNullOrWhiteSpace(x)));
                if (!string.IsNullOrWhiteSpace(combined)) return combined;
            }

            return e.Name ?? "";
        }

        private static string BuildOutletSearchText(Document doc, Element e, string token)
        {
            var type = doc.GetElement(e.GetTypeId()) as ElementType;
            var family = (type as FamilySymbol)?.FamilyName ?? (type as FamilySymbol)?.Family?.Name ?? "";
            var typeName = type?.Name ?? "";
            return string.Join(" | ", new[]
            {
                e.Category?.Name ?? "",
                e.Name ?? "",
                family,
                typeName,
                token
            });
        }

        private static bool MatchesAnyKeyword(string text, List<string> keywords)
        {
            if (keywords.Count == 0) return true;
            var t = (text ?? "").ToLowerInvariant();
            return keywords.Any(k => t.Contains(k.ToLowerInvariant()));
        }

        private static string? ResolveElementRoomNumber(Document doc, Element e, List<SpatialEntry> spaces)
        {
            try
            {
                if (e is FamilyInstance fi)
                {
                    try
                    {
                        if (fi.Room != null && !string.IsNullOrWhiteSpace(fi.Room.Number))
                            return NormalizeRoomNumber(fi.Room.Number);
                    }
                    catch { }

                    try
                    {
                        var sp = fi.Space;
                        if (sp != null && !string.IsNullOrWhiteSpace(sp.Number))
                            return NormalizeRoomNumber(sp.Number);
                    }
                    catch { }
                }
            }
            catch { }

            var point = ResolveElementLocationPoint(e);
            if (point == null) return null;

            foreach (var r in spaces)
            {
                if (IsPointInsideSpatial(r.element, point)) return r.normalizedNumber;
            }

            return null;
        }

        private static string NormalizeAction(string? action)
        {
            var a = (action ?? "audit_air_devices").Trim().ToLowerInvariant();
            if (a == "air_device" || a == "air_device_type_audit") return "audit_air_devices";
            if (a == "connected_flow" || a == "terminal_connected_flow") return "audit_connected_flow";
            if (a == "air_balance" || a == "reconcile_air_balance") return "reconcile_air_balance_sheet";
            if (a == "layout_from_sheet" || a == "place_air_terminals_from_sheet" || a == "air_balance_layout") return "layout_air_terminals_from_sheet";
            if (a == "tag_terminals" || a == "tag_air_terminals") return "tag_airflow_terminals";
            if (a == "pressure_regions" || a == "apply_pressure_regions") return "apply_pressure_regions_from_sheet";
            if (a == "medical_gas" || a == "medical_gas_outlet_audit") return "audit_medical_gas_outlets";
            return a;
        }

        private static string NormalizeModelMode(string? mode, string fallback)
        {
            var m = (mode ?? fallback).Trim().ToLowerInvariant();
            if (m != "host" && m != "link") return fallback;
            return m;
        }

        private static Document? ResolveModelDoc(Document hostDoc, string mode, string linkNameContains, out string label)
        {
            if (mode.Equals("host", StringComparison.OrdinalIgnoreCase))
            {
                label = $"host:{hostDoc.Title}";
                return hostDoc;
            }

            var links = new FilteredElementCollector(hostDoc)
                .OfClass(typeof(RevitLinkInstance))
                .Cast<RevitLinkInstance>()
                .ToList();

            RevitLinkInstance? selected = null;
            foreach (var li in links)
            {
                var ld = li.GetLinkDocument();
                if (ld == null) continue;

                var candidate = string.Join(" | ", new[] { li.Name ?? "", ld.Title ?? "" });
                if (!string.IsNullOrWhiteSpace(linkNameContains) &&
                    candidate.IndexOf(linkNameContains, StringComparison.OrdinalIgnoreCase) < 0)
                    continue;

                selected = li;
                break;
            }

            if (selected == null)
            {
                label = "link:(unresolved)";
                return null;
            }

            var doc = selected.GetLinkDocument();
            label = doc == null ? "link:(unloaded)" : $"link:{selected.Name} ({doc.Title})";
            return doc;
        }

        private static Dictionary<string, SpatialEntry> BuildSpatialIndexByNumber(Document doc, bool preferRooms)
        {
            var list = BuildSpatialList(doc, preferRooms);
            var map = new Dictionary<string, SpatialEntry>(StringComparer.OrdinalIgnoreCase);
            foreach (var x in list)
            {
                if (!map.ContainsKey(x.normalizedNumber)) map[x.normalizedNumber] = x;
            }
            return map;
        }

        private static List<SpatialEntry> BuildSpatialList(Document doc, bool preferRooms)
        {
            var rooms = new FilteredElementCollector(doc)
                .OfCategory(BuiltInCategory.OST_Rooms)
                .WhereElementIsNotElementType()
                .Cast<SpatialElement>()
                .OfType<Room>()
                .Where(r => !string.IsNullOrWhiteSpace(r.Number))
                .Select(r => new SpatialEntry
                {
                    element = r,
                    number = r.Number,
                    normalizedNumber = NormalizeRoomNumber(r.Number),
                    name = r.Name ?? "",
                    kind = "Room"
                })
                .Where(x => x.normalizedNumber.Length > 0)
                .ToList();

            var spaces = new FilteredElementCollector(doc)
                .OfCategory(BuiltInCategory.OST_MEPSpaces)
                .WhereElementIsNotElementType()
                .Cast<SpatialElement>()
                .OfType<Space>()
                .Where(s => !string.IsNullOrWhiteSpace(s.Number))
                .Select(s => new SpatialEntry
                {
                    element = s,
                    number = s.Number,
                    normalizedNumber = NormalizeRoomNumber(s.Number),
                    name = s.Name ?? "",
                    kind = "Space"
                })
                .Where(x => x.normalizedNumber.Length > 0)
                .ToList();

            if (preferRooms) return rooms.Count > 0 ? rooms : spaces;
            return spaces.Count > 0 ? spaces : rooms;
        }

        private static bool TryResolveCategory(Document doc, string raw, out BuiltInCategory bic, out string displayName)
        {
            displayName = raw;
            if (Enum.TryParse(raw, true, out bic) && bic != BuiltInCategory.INVALID)
            {
                var cat = Category.GetCategory(doc, bic);
                displayName = cat?.Name ?? bic.ToString();
                return true;
            }

            var categories = doc.Settings?.Categories;
            if (categories != null)
            {
                foreach (Category c in categories)
                {
                    if (!string.Equals(c.Name, raw, StringComparison.OrdinalIgnoreCase)) continue;
                    if (c.BuiltInCategory == BuiltInCategory.INVALID) continue;
                    bic = c.BuiltInCategory;
                    displayName = c.Name;
                    return true;
                }
            }

            bic = BuiltInCategory.INVALID;
            return false;
        }

        private static List<BuiltInCategory> ResolveCategoryList(Document doc, List<string> raw, out List<string> unknown)
        {
            unknown = new List<string>();
            var outList = new List<BuiltInCategory>();
            foreach (var r in raw)
            {
                if (string.IsNullOrWhiteSpace(r)) continue;
                if (TryResolveCategory(doc, r.Trim(), out var bic, out _))
                {
                    if (!outList.Contains(bic)) outList.Add(bic);
                }
                else
                {
                    unknown.Add(r.Trim());
                }
            }
            return outList;
        }

        private static IEnumerable<string> NormalizeStringList(IEnumerable<string?>? input, IEnumerable<string> fallback)
        {
            var outList = new List<string>();
            if (input != null)
            {
                foreach (var s in input)
                {
                    var t = (s ?? "").Trim();
                    if (t.Length == 0) continue;
                    if (!outList.Contains(t, StringComparer.OrdinalIgnoreCase)) outList.Add(t);
                }
            }

            if (outList.Count == 0)
            {
                foreach (var f in fallback)
                {
                    var t = (f ?? "").Trim();
                    if (t.Length == 0) continue;
                    if (!outList.Contains(t, StringComparer.OrdinalIgnoreCase)) outList.Add(t);
                }
            }

            return outList;
        }

        private static FlowReadResult ReadFlowForElement(Document doc, Element e, IEnumerable<string> names)
        {
            foreach (var n in names)
            {
                if (string.IsNullOrWhiteSpace(n)) continue;

                var instanceParam = e.LookupParameter(n);
                if (instanceParam != null && TryReadFlowCfm(doc, instanceParam, out var cfm, out var raw))
                {
                    return new FlowReadResult { ok = true, cfm = cfm, parameterName = n, parameterScope = "instance", raw = raw };
                }

                var typeParam = GetElementTypeParameter(doc, e, n);
                if (typeParam != null && TryReadFlowCfm(doc, typeParam, out cfm, out raw))
                {
                    return new FlowReadResult { ok = true, cfm = cfm, parameterName = n, parameterScope = "type", raw = raw };
                }
            }

            return new FlowReadResult { ok = false };
        }

        private static bool TryReadFlowCfm(Document doc, Parameter param, out double cfm, out string raw)
        {
            raw = (param.AsString() ?? param.AsValueString() ?? "").Trim();
            if (TryExtractFirstNumber(raw, out cfm)) return true;

            try
            {
                switch (param.StorageType)
                {
                    case StorageType.Double:
                    {
                        var internalValue = param.AsDouble();
                        cfm = TryConvertInternalToDisplayUnit(doc, param, internalValue, out var display) ? display : internalValue;
                        raw = raw.Length == 0 ? cfm.ToString("G17", CultureInfo.InvariantCulture) : raw;
                        return true;
                    }
                    case StorageType.Integer:
                        cfm = param.AsInteger();
                        raw = raw.Length == 0 ? cfm.ToString(CultureInfo.InvariantCulture) : raw;
                        return true;
                    default:
                        cfm = 0;
                        return false;
                }
            }
            catch
            {
                cfm = 0;
                return false;
            }
        }

        private static bool TrySetFlowOnElement(
            Document doc,
            Element e,
            double cfm,
            IEnumerable<string> candidateNames,
            out string? parameterName,
            out string? scope,
            out string? error)
        {
            parameterName = null;
            scope = null;
            error = null;

            foreach (var n in candidateNames)
            {
                if (string.IsNullOrWhiteSpace(n)) continue;

                var pInst = e.LookupParameter(n);
                if (TrySetFlowOnParameter(doc, pInst, cfm, out var errInst))
                {
                    parameterName = n;
                    scope = "instance";
                    return true;
                }
                if (!string.IsNullOrWhiteSpace(errInst)) error = errInst;

                var pType = GetElementTypeParameter(doc, e, n);
                if (TrySetFlowOnParameter(doc, pType, cfm, out var errType))
                {
                    parameterName = n;
                    scope = "type";
                    return true;
                }
                if (!string.IsNullOrWhiteSpace(errType)) error = errType;
            }

            return false;
        }

        private static bool TrySetFlowOnParameter(Document doc, Parameter? p, double cfm, out string? error)
        {
            error = null;
            if (p == null) return false;
            if (p.IsReadOnly)
            {
                error = "Parameter is read-only.";
                return false;
            }

            try
            {
                switch (p.StorageType)
                {
                    case StorageType.String:
                        return p.Set(Math.Round(cfm, 1).ToString(CultureInfo.InvariantCulture));
                    case StorageType.Integer:
                        return p.Set((int)Math.Round(cfm));
                    case StorageType.Double:
                    {
                        var internalValue = cfm;
                        if (TryConvertDisplayToInternalUnit(doc, p, cfm, out var converted)) internalValue = converted;
                        return p.Set(internalValue);
                    }
                    default:
                        error = $"Unsupported flow storage type: {p.StorageType}";
                        return false;
                }
            }
            catch (Exception ex)
            {
                error = ex.Message;
                return false;
            }
        }

        private static bool TrySetStringOnElement(Element e, string parameterName, string value, out string? error)
        {
            error = null;
            if (string.IsNullOrWhiteSpace(parameterName))
            {
                error = "Parameter name is empty.";
                return false;
            }

            var p = e.LookupParameter(parameterName);
            if (p == null)
            {
                error = $"Parameter '{parameterName}' not found.";
                return false;
            }
            if (p.IsReadOnly)
            {
                error = $"Parameter '{parameterName}' is read-only.";
                return false;
            }

            try
            {
                if (p.StorageType == StorageType.String) return p.Set(value ?? "");
                if (p.StorageType == StorageType.Integer)
                {
                    if (int.TryParse((value ?? "").Trim(), NumberStyles.Integer, CultureInfo.InvariantCulture, out var iv)) return p.Set(iv);
                    error = $"Parameter '{parameterName}' expects integer.";
                    return false;
                }

                if (p.StorageType == StorageType.Double)
                {
                    if (double.TryParse((value ?? "").Trim(), NumberStyles.Float, CultureInfo.InvariantCulture, out var dv)) return p.Set(dv);
                    error = $"Parameter '{parameterName}' expects number.";
                    return false;
                }

                error = $"Parameter '{parameterName}' storage type {p.StorageType} is not supported for text write.";
                return false;
            }
            catch (Exception ex)
            {
                error = ex.Message;
                return false;
            }
        }

        private static bool TryConvertInternalToDisplayUnit(Document doc, Parameter p, double internalValue, out double displayValue)
        {
            displayValue = internalValue;
            try
            {
                var spec = p.Definition?.GetDataType();
                if (spec == null) return false;

                var units = doc.GetUnits();
                var fo = units.GetFormatOptions(spec);
                var unitId = fo?.GetUnitTypeId();
                if (unitId == null) return false;

                displayValue = UnitUtils.ConvertFromInternalUnits(internalValue, unitId);
                return true;
            }
            catch
            {
                return false;
            }
        }

        private static bool TryConvertDisplayToInternalUnit(Document doc, Parameter p, double displayValue, out double internalValue)
        {
            internalValue = displayValue;
            try
            {
                var spec = p.Definition?.GetDataType();
                if (spec == null) return false;

                var units = doc.GetUnits();
                var fo = units.GetFormatOptions(spec);
                var unitId = fo?.GetUnitTypeId();
                if (unitId == null) return false;

                internalValue = UnitUtils.ConvertToInternalUnits(displayValue, unitId);
                return true;
            }
            catch
            {
                return false;
            }
        }

        private static Parameter? GetElementTypeParameter(Document doc, Element e, string parameterName)
        {
            if (e == null || string.IsNullOrWhiteSpace(parameterName)) return null;
            try
            {
                var tid = e.GetTypeId();
                if (tid == ElementId.InvalidElementId) return null;
                var type = doc.GetElement(tid);
                return type?.LookupParameter(parameterName);
            }
            catch
            {
                return null;
            }
        }

        private static string? ReadStringParameterWithTypeFallback(Document doc, Element e, string parameterName)
        {
            if (string.IsNullOrWhiteSpace(parameterName)) return null;
            try
            {
                var pInst = e.LookupParameter(parameterName);
                var vInst = (pInst?.AsString() ?? pInst?.AsValueString() ?? "").Trim();
                if (vInst.Length > 0) return vInst;
            }
            catch { }

            try
            {
                var pType = GetElementTypeParameter(doc, e, parameterName);
                var vType = (pType?.AsString() ?? pType?.AsValueString() ?? "").Trim();
                if (vType.Length > 0) return vType;
            }
            catch { }

            return null;
        }

        private static string? InferDesignationFromTypeName(string typeName)
        {
            if (string.IsNullOrWhiteSpace(typeName)) return null;
            var m = Regex.Match(typeName, @"\b([A-Za-z]\d{1,3})\b");
            return m.Success ? m.Groups[1].Value : null;
        }

        private static AirflowRule? FindRuleForFlow(List<AirflowRule> rules, double flowCfm, double tolerance)
        {
            foreach (var r in rules)
            {
                if (flowCfm >= r.minCfm - tolerance && flowCfm <= r.maxCfm + tolerance)
                    return r;
            }
            return null;
        }

        private static ElementType? ResolveFamilyTypeForDesignation(Document doc, FamilyInstance fi, string designationParamName, string targetDesignation)
        {
            var family = fi.Symbol?.Family;
            if (family == null) return null;

            ElementType? best = null;
            var bestScore = int.MinValue;

            foreach (var id in family.GetFamilySymbolIds())
            {
                var et = doc.GetElement(id) as ElementType;
                if (et == null) continue;

                var score = 0;
                var token = ReadStringParameterWithTypeFallback(doc, et, designationParamName);
                if (!string.IsNullOrWhiteSpace(token) && string.Equals(token, targetDesignation, StringComparison.OrdinalIgnoreCase))
                    score += 100;

                var name = et.Name ?? "";
                if (name.Equals(targetDesignation, StringComparison.OrdinalIgnoreCase))
                    score += 80;
                if (name.IndexOf(targetDesignation, StringComparison.OrdinalIgnoreCase) >= 0)
                    score += 50;

                if (score > bestScore)
                {
                    bestScore = score;
                    best = et;
                }
            }

            return bestScore > 0 ? best : null;
        }

        private static List<long> TraceNetworkElementIds(Document doc, Element start, int maxHops, int maxElements)
        {
            var visited = new HashSet<long>();
            var q = new Queue<(long id, int depth)>();

            visited.Add(RevitBridge.Common.ElementIdCompat.GetValue(start.Id));
            q.Enqueue((RevitBridge.Common.ElementIdCompat.GetValue(start.Id), 0));

            while (q.Count > 0)
            {
                var cur = q.Dequeue();
                if (cur.depth >= maxHops) continue;

                var e = doc.GetElement(RevitBridge.Common.ElementIdCompat.Create(cur.id));
                if (e == null) continue;

                foreach (var next in GetConnectedOwnerElementIds(e))
                {
                    var nid = RevitBridge.Common.ElementIdCompat.GetValue(next);
                    if (nid <= 0) continue;
                    if (!visited.Add(nid)) continue;
                    if (visited.Count >= maxElements) return visited.OrderBy(x => x).ToList();
                    q.Enqueue((nid, cur.depth + 1));
                }
            }

            return visited.OrderBy(x => x).ToList();
        }

        private static IEnumerable<ElementId> GetConnectedOwnerElementIds(Element e)
        {
            var owner = e.Id;
            var seen = new HashSet<long>();

            foreach (var c in GetConnectors(e))
            {
                ConnectorSet? refs = null;
                try { refs = c.AllRefs; } catch { refs = null; }
                if (refs == null) continue;

                foreach (Connector r in refs)
                {
                    ElementId? connectedOwnerId = null;
                    try
                    {
                        var o = r.Owner;
                        if (o == null || o.Id == null || o.Id == owner) continue;
                        if (seen.Add(RevitBridge.Common.ElementIdCompat.GetValue(o.Id))) connectedOwnerId = o.Id;
                    }
                    catch
                    {
                        // ignore broken refs
                    }

                    if (connectedOwnerId != null) yield return connectedOwnerId;
                }
            }
        }

        private static IEnumerable<Connector> GetConnectors(Element e)
        {
            if (e is MEPCurve curve)
            {
                ConnectorSet? set = null;
                try { set = curve.ConnectorManager?.Connectors; } catch { set = null; }
                if (set != null)
                {
                    foreach (Connector c in set)
                    {
                        if (c != null) yield return c;
                    }
                    yield break;
                }
            }

            if (e is FamilyInstance fi)
            {
                ConnectorSet? set = null;
                try { set = fi.MEPModel?.ConnectorManager?.Connectors; } catch { set = null; }
                if (set != null)
                {
                    foreach (Connector c in set)
                    {
                        if (c != null) yield return c;
                    }
                }
            }
        }

        private static bool MatchesSystemClassification(Element e, string? required)
        {
            var req = (required ?? "").Trim();
            if (req.Length == 0) return true;
            if (req.Equals("any", StringComparison.OrdinalIgnoreCase) || req.Equals("all", StringComparison.OrdinalIgnoreCase)) return true;

            var reqCanon = CanonicalSystem(req);
            var candidates = new List<string>();

            TryPushSystemText(e, BuiltInParameter.RBS_SYSTEM_NAME_PARAM, candidates);
            TryPushSystemText(e, "System Classification", candidates);
            TryPushSystemText(e, "System Classification Name", candidates);
            TryPushSystemText(e, "System Name", candidates);
            TryPushSystemText(e, "System Type", candidates);

            foreach (var c in candidates)
            {
                if (string.IsNullOrWhiteSpace(c)) continue;
                if (c.Equals(req, StringComparison.OrdinalIgnoreCase)) return true;
                if (c.IndexOf(req, StringComparison.OrdinalIgnoreCase) >= 0) return true;

                var cc = CanonicalSystem(c);
                if (reqCanon.Length > 0 && cc.Equals(reqCanon, StringComparison.OrdinalIgnoreCase)) return true;
            }

            return false;
        }

        private static string InferSystemClassificationText(Element e)
        {
            var candidates = new List<string>();
            TryPushSystemText(e, BuiltInParameter.RBS_SYSTEM_NAME_PARAM, candidates);
            TryPushSystemText(e, "System Classification", candidates);
            TryPushSystemText(e, "System Type", candidates);

            foreach (var c in candidates)
            {
                var canon = CanonicalSystem(c);
                if (canon.Length > 0) return canon;
            }

            return candidates.FirstOrDefault() ?? "";
        }

        private static void TryPushSystemText(Element e, BuiltInParameter bip, List<string> outList)
        {
            try
            {
                var p = e.get_Parameter(bip);
                var s = (p?.AsString() ?? p?.AsValueString() ?? "").Trim();
                if (s.Length > 0 && !outList.Contains(s, StringComparer.OrdinalIgnoreCase)) outList.Add(s);
            }
            catch { }
        }

        private static void TryPushSystemText(Element e, string parameterName, List<string> outList)
        {
            try
            {
                var p = e.LookupParameter(parameterName);
                var s = (p?.AsString() ?? p?.AsValueString() ?? "").Trim();
                if (s.Length > 0 && !outList.Contains(s, StringComparer.OrdinalIgnoreCase)) outList.Add(s);
            }
            catch { }
        }

        private static string CanonicalSystem(string raw)
        {
            var t = NormalizeToken(raw);
            if (t.Length == 0) return "";
            if (t.Contains("supply")) return "supply";
            if (t.Contains("return") || t == "ra") return "return";
            if (t.Contains("exhaust") || t.Contains("relief") || t == "ea") return "exhaust";
            return "";
        }

        private static string NormalizeToken(string s)
        {
            var t = (s ?? "").Trim().ToLowerInvariant();
            var chars = t.Select(ch => char.IsLetterOrDigit(ch) ? ch : ' ').ToArray();
            var compact = new string(chars);
            while (compact.IndexOf("  ", StringComparison.Ordinal) >= 0) compact = compact.Replace("  ", " ");
            return compact.Trim();
        }

        private static Dictionary<string, int> BuildHeaderIndex(List<string> headerRow)
        {
            var map = new Dictionary<string, int>(StringComparer.OrdinalIgnoreCase);
            for (int i = 0; i < headerRow.Count; i++)
            {
                var h = (headerRow[i] ?? "").Trim();
                if (h.Length == 0) continue;
                var key = NormalizeHeader(h);
                if (!map.ContainsKey(key)) map[key] = i;
            }
            return map;
        }

        private static int ResolveHeaderIndex(Dictionary<string, int> headerIndex, string preferred, IEnumerable<string> fallbacks)
        {
            if (!string.IsNullOrWhiteSpace(preferred))
            {
                var k = NormalizeHeader(preferred);
                if (headerIndex.TryGetValue(k, out var idx)) return idx;
            }

            foreach (var f in fallbacks)
            {
                var k = NormalizeHeader(f);
                if (headerIndex.TryGetValue(k, out var idx)) return idx;
            }

            return -1;
        }

        private static string NormalizeHeader(string text)
        {
            var t = (text ?? "").Trim().ToLowerInvariant();
            var chars = t.Where(char.IsLetterOrDigit).ToArray();
            return new string(chars);
        }

        private static List<MappingPlan> BuildSpreadsheetMappings(List<SpreadsheetFlowMapping>? requested, Dictionary<string, int> headerIndex)
        {
            var plans = new List<MappingPlan>();

            var req = (requested ?? new List<SpreadsheetFlowMapping>())
                .Where(x => x != null && !string.IsNullOrWhiteSpace(x.columnName) && !string.IsNullOrWhiteSpace(x.roomParameterName))
                .ToList();

            if (req.Count == 0)
            {
                req = new List<SpreadsheetFlowMapping>
                {
                    new SpreadsheetFlowMapping { columnName = "Supply CFM", roomParameterName = "Supply Airflow", label = "SA", toleranceCfm = 5 },
                    new SpreadsheetFlowMapping { columnName = "Return CFM", roomParameterName = "Return Airflow", label = "RA", toleranceCfm = 5 },
                    new SpreadsheetFlowMapping { columnName = "Exhaust CFM", roomParameterName = "Exhaust Airflow", label = "EA", toleranceCfm = 5 }
                };
            }

            foreach (var m in req)
            {
                var idx = ResolveHeaderIndex(headerIndex, m.columnName, Array.Empty<string>());
                if (idx < 0) continue;

                plans.Add(new MappingPlan
                {
                    columnName = m.columnName.Trim(),
                    columnIndex = idx,
                    roomParameterName = m.roomParameterName.Trim(),
                    label = string.IsNullOrWhiteSpace(m.label) ? m.roomParameterName.Trim() : m.label!.Trim(),
                    toleranceCfm = m.toleranceCfm
                });
            }

            return plans;
        }

        private static string SafeCell(List<string> row, int index)
        {
            if (index < 0 || index >= row.Count) return "";
            return row[index] ?? "";
        }

        private static bool TryExtractFirstNumber(string? raw, out double value)
        {
            value = 0;
            var s = (raw ?? "").Trim();
            if (s.Length == 0) return false;

            if (double.TryParse(s, NumberStyles.Float, CultureInfo.InvariantCulture, out value)) return true;
            if (double.TryParse(s, NumberStyles.Float, CultureInfo.CurrentCulture, out value)) return true;

            var m = NumberRegex.Match(s);
            if (!m.Success) return false;
            var token = m.Value;
            if (double.TryParse(token, NumberStyles.Float, CultureInfo.InvariantCulture, out value)) return true;
            if (double.TryParse(token, NumberStyles.Float, CultureInfo.CurrentCulture, out value)) return true;
            return false;
        }

        private static string NormalizeRoomNumber(string raw)
        {
            var t = (raw ?? "").Trim();
            if (t.Length == 0) return "";

            if (t.All(char.IsDigit))
            {
                var trimmed = t.TrimStart('0');
                return trimmed.Length == 0 ? "0" : trimmed;
            }

            return t.ToUpperInvariant();
        }

        private static string ClassifyPressureText(string? raw)
        {
            var t = (raw ?? "").Trim().ToLowerInvariant();
            if (t.Length == 0) return "unregulated";
            if (t.Contains("positive") || t.Contains("pos") || t.Contains("+") || t.Contains("pressur")) return "positive";
            if (t.Contains("negative") || t.Contains("neg") || t.Contains("-") || t.Contains("depressur")) return "negative";
            if (t.Contains("neutral") || t.Contains("none") || t.Contains("n/a") || t.Contains("unreg")) return "unregulated";
            return "unregulated";
        }

        private static List<TerminalPlacementPlan> BuildTerminalPlacementPlans(
            List<TerminalPlacementSpec>? specs,
            Dictionary<string, int> headerIndex,
            double? defaultMaxDeviceCfm,
            double? defaultMinSeparationFeet)
        {
            var input = (specs ?? new List<TerminalPlacementSpec>())
                .Where(x => x != null && !string.IsNullOrWhiteSpace(x.label))
                .ToList();

            if (input.Count == 0)
            {
                input = new List<TerminalPlacementSpec>
                {
                    new TerminalPlacementSpec { label = "SA", columnName = "Supply CFM", typeNameContains = "SUPPLY", maxCfmPerDevice = 400, minSeparationFeet = 3 },
                    new TerminalPlacementSpec { label = "RA", columnName = "Return CFM", typeNameContains = "RETURN", maxCfmPerDevice = 400, minSeparationFeet = 3 },
                    new TerminalPlacementSpec { label = "EA", columnName = "Exhaust CFM", typeNameContains = "EXHAUST", maxCfmPerDevice = 400, minSeparationFeet = 3 }
                };
            }

            var plans = new List<TerminalPlacementPlan>();
            foreach (var s in input)
            {
                var column = (s.columnName ?? "").Trim();
                if (column.Length == 0) column = $"{s.label} CFM";
                var idx = ResolveHeaderIndex(headerIndex, column, new[] { s.label, $"{s.label} CFM", $"{s.label} Flow" });
                if (idx < 0) continue;

                plans.Add(new TerminalPlacementPlan
                {
                    label = s.label.Trim(),
                    columnName = column,
                    columnIndex = idx,
                    familyName = (s.familyName ?? "").Trim(),
                    familyNameContains = (s.familyNameContains ?? "").Trim(),
                    typeName = (s.typeName ?? "").Trim(),
                    typeNameContains = (s.typeNameContains ?? "").Trim(),
                    flowParameterName = (s.flowParameterName ?? "").Trim(),
                    maxCfmPerDevice = Math.Max(1.0, s.maxCfmPerDevice ?? defaultMaxDeviceCfm ?? 400.0),
                    minSeparationFeet = Math.Max(0.5, s.minSeparationFeet ?? defaultMinSeparationFeet ?? 3.0)
                });
            }

            return plans;
        }

        private static FamilySymbol? ResolveTerminalSymbol(Document doc, TerminalPlacementPlan plan, out string message)
        {
            var all = new FilteredElementCollector(doc)
                .OfClass(typeof(FamilySymbol))
                .OfCategory(BuiltInCategory.OST_DuctTerminal)
                .Cast<FamilySymbol>()
                .ToList();

            var familyName = (plan.familyName ?? "").Trim();
            var familyContains = (plan.familyNameContains ?? "").Trim();
            var typeName = (plan.typeName ?? "").Trim();
            var typeContains = (plan.typeNameContains ?? "").Trim();
            var labelToken = NormalizeHeader(plan.label);

            var filtered = all.Where(s =>
            {
                if (!string.IsNullOrWhiteSpace(familyName) &&
                    !string.Equals(s.FamilyName ?? "", familyName, StringComparison.OrdinalIgnoreCase))
                    return false;

                if (!string.IsNullOrWhiteSpace(familyContains) &&
                    (s.FamilyName ?? "").IndexOf(familyContains, StringComparison.OrdinalIgnoreCase) < 0)
                    return false;

                if (!string.IsNullOrWhiteSpace(typeName) &&
                    !string.Equals(s.Name ?? "", typeName, StringComparison.OrdinalIgnoreCase))
                    return false;

                if (!string.IsNullOrWhiteSpace(typeContains) &&
                    (s.Name ?? "").IndexOf(typeContains, StringComparison.OrdinalIgnoreCase) < 0)
                    return false;

                return true;
            }).ToList();

            if (filtered.Count == 0)
            {
                message = $"No duct-terminal symbol matched label={plan.label}, family/type selectors.";
                return null;
            }

            FamilySymbol? best = null;
            var bestScore = int.MinValue;
            foreach (var s in filtered)
            {
                var score = 0;
                var fam = s.FamilyName ?? "";
                var type = s.Name ?? "";
                var token = NormalizeHeader($"{fam} {type}");
                if (labelToken.Length > 0 && token.Contains(labelToken)) score += 40;
                if (!string.IsNullOrWhiteSpace(typeContains) && type.IndexOf(typeContains, StringComparison.OrdinalIgnoreCase) >= 0) score += 20;
                if (!string.IsNullOrWhiteSpace(familyContains) && fam.IndexOf(familyContains, StringComparison.OrdinalIgnoreCase) >= 0) score += 20;
                if (!string.IsNullOrWhiteSpace(typeName) && type.Equals(typeName, StringComparison.OrdinalIgnoreCase)) score += 40;
                if (!string.IsNullOrWhiteSpace(familyName) && fam.Equals(familyName, StringComparison.OrdinalIgnoreCase)) score += 30;

                if (score > bestScore)
                {
                    bestScore = score;
                    best = s;
                }
            }

            if (best == null)
            {
                message = $"No preferred symbol found for label={plan.label}.";
                return null;
            }

            message = $"Resolved symbol: {best.FamilyName} : {best.Name}";
            return best;
        }

        private static Level? ResolveSpatialLevel(Document doc, SpatialElement spatial)
        {
            if (spatial is Room room && room.Level != null) return room.Level;

            try
            {
                if (spatial.LevelId != ElementId.InvalidElementId)
                {
                    return doc.GetElement(spatial.LevelId) as Level;
                }
            }
            catch { }

            var point = ResolveElementLocationPoint(spatial);
            if (point != null)
            {
                var all = new FilteredElementCollector(doc).OfClass(typeof(Level)).Cast<Level>().ToList();
                if (all.Count > 0)
                {
                    return all.OrderBy(l => Math.Abs((l.Elevation) - point.Z)).FirstOrDefault();
                }
            }

            return new FilteredElementCollector(doc).OfClass(typeof(Level)).Cast<Level>().FirstOrDefault();
        }

        private static bool TryCreateFamilyInstance(Document doc, FamilySymbol symbol, XYZ point, Level? level, out FamilyInstance? fi, out string? error)
        {
            fi = null;
            error = null;

            try
            {
                if (!symbol.IsActive) symbol.Activate();
            }
            catch (Exception ex)
            {
                error = $"Failed to activate symbol: {ex.Message}";
                return false;
            }

            try
            {
                if (level != null)
                {
                    fi = doc.Create.NewFamilyInstance(point, symbol, level, Autodesk.Revit.DB.Structure.StructuralType.NonStructural);
                }
                else
                {
                    fi = doc.Create.NewFamilyInstance(point, symbol, Autodesk.Revit.DB.Structure.StructuralType.NonStructural);
                }
                return fi != null;
            }
            catch
            {
                try
                {
                    fi = doc.Create.NewFamilyInstance(point, symbol, Autodesk.Revit.DB.Structure.StructuralType.NonStructural);
                    return fi != null;
                }
                catch (Exception ex2)
                {
                    error = ex2.Message;
                    return false;
                }
            }
        }

        private static List<XYZ> ComputeDistributedPointsForSpatial(
            Document doc,
            SpatialElement spatial,
            int count,
            double minSeparationFeet,
            View? view,
            bool preferGridIntersections,
            bool strictGridIntersections,
            List<XYZ> existingDevicePoints,
            double existingDeviceClearanceFeet)
        {
            var result = new List<XYZ>();
            if (count <= 0) return result;

            var basePoint = ResolveElementLocationPoint(spatial);

            BoundingBoxXYZ? bb = null;
            try { bb = spatial.get_BoundingBox(view); } catch { bb = null; }
            if (bb == null) try { bb = spatial.get_BoundingBox(null); } catch { bb = null; }
            if (bb == null)
            {
                if (basePoint != null)
                {
                    if (IsPointClearFromExisting(basePoint, existingDevicePoints, existingDeviceClearanceFeet))
                    {
                        while (result.Count < count) result.Add(basePoint);
                    }
                }
                return result;
            }

            var z = (basePoint != null && !double.IsNaN(basePoint.Z)) ? basePoint.Z : bb.Min.Z;
            var gridCandidates = preferGridIntersections
                ? CollectGridIntersectionCandidates(doc, spatial, z, view)
                : new List<XYZ>();

            var sampleCandidates = BuildSpatialSampleCandidates(spatial, bb, z, minSeparationFeet);

            List<XYZ> candidates;
            if (strictGridIntersections && gridCandidates.Count > 0)
            {
                candidates = gridCandidates;
            }
            else
            {
                candidates = MergeDistinctPoints(gridCandidates, sampleCandidates);
            }

            candidates = candidates
                .Where(c => IsPointClearFromExisting(c, existingDevicePoints, existingDeviceClearanceFeet))
                .ToList();

            if (candidates.Count == 0)
            {
                if (basePoint != null && IsPointInsideSpatial(spatial, basePoint) && IsPointClearFromExisting(basePoint, existingDevicePoints, existingDeviceClearanceFeet))
                {
                    while (result.Count < count) result.Add(basePoint);
                }
                return result;
            }

            var center = basePoint ?? new XYZ((bb.Min.X + bb.Max.X) * 0.5, (bb.Min.Y + bb.Max.Y) * 0.5, z);
            var ordered = candidates
                .OrderBy(c => c.DistanceTo(center))
                .ToList();

            foreach (var c in ordered)
            {
                if (result.Count >= count) break;
                if (result.Any(existing => existing.DistanceTo(c) < minSeparationFeet)) continue;
                result.Add(c);
            }

            if (result.Count < count)
            {
                var relaxedSeparation = Math.Max(0.25, minSeparationFeet * 0.5);
                foreach (var c in ordered)
                {
                    if (result.Count >= count) break;
                    if (result.Any(existing => existing.DistanceTo(c) < relaxedSeparation)) continue;
                    result.Add(c);
                }
            }

            return result;
        }

        private static List<BuiltInCategory> ResolveLayoutClashCategories(Document doc, List<string>? rawCategories, List<string> warnings)
        {
            var requested = (rawCategories ?? new List<string>())
                .Where(x => !string.IsNullOrWhiteSpace(x))
                .Select(x => x.Trim())
                .ToList();

            if (requested.Count == 0)
            {
                requested = DefaultLayoutClashCategories.ToList();
            }

            var categories = ResolveCategoryList(doc, requested, out var unknown);
            if (unknown.Count > 0)
            {
                warnings.Add($"Unknown clashCategoryNames ignored: {string.Join(", ", unknown)}");
            }
            if (categories.Count == 0)
            {
                warnings.Add("No valid clash categories resolved; clash-avoidance used an empty category set.");
            }

            return categories;
        }

        private static List<XYZ> CollectExistingDevicePointsInSpatial(Document doc, View? view, SpatialElement spatial, List<BuiltInCategory> categories)
        {
            var points = new List<XYZ>();
            if (categories == null || categories.Count == 0) return points;

            foreach (var bic in categories.Distinct())
            {
                FilteredElementCollector collector;
                try
                {
                    collector = view != null
                        ? new FilteredElementCollector(doc, view.Id)
                        : new FilteredElementCollector(doc);
                }
                catch
                {
                    collector = new FilteredElementCollector(doc);
                }

                foreach (var e in collector.WhereElementIsNotElementType().OfCategory(bic))
                {
                    var p = ResolveElementLocationPoint(e);
                    if (p == null) continue;
                    if (!IsPointInsideSpatial(spatial, p)) continue;
                    points.Add(p);
                }
            }

            return MergeDistinctPoints(points, new List<XYZ>());
        }

        private static List<XYZ> CollectGridIntersectionCandidates(Document doc, SpatialElement spatial, double z, View? view)
        {
            var candidates = new List<XYZ>();

            var grids = new List<Grid>();
            try
            {
                if (view != null)
                {
                    grids = new FilteredElementCollector(doc, view.Id).OfClass(typeof(Grid)).Cast<Grid>().ToList();
                }
            }
            catch
            {
                grids = new List<Grid>();
            }

            if (grids.Count < 2)
            {
                grids = new FilteredElementCollector(doc).OfClass(typeof(Grid)).Cast<Grid>().ToList();
            }

            if (grids.Count < 2) return candidates;

            for (int i = 0; i < grids.Count; i++)
            {
                var c1 = grids[i].Curve;
                if (c1 == null) continue;
                for (int j = i + 1; j < grids.Count; j++)
                {
                    var c2 = grids[j].Curve;
                    if (c2 == null) continue;

                    try
                    {
                        var relation = c1.Intersect(c2, out var ira);
                        if (relation != SetComparisonResult.Overlap || ira == null || ira.Size == 0) continue;
                        for (int k = 0; k < ira.Size; k++)
                        {
                            var ip = ira.get_Item(k)?.XYZPoint;
                            if (ip == null) continue;
                            var p = new XYZ(ip.X, ip.Y, z);
                            if (!IsPointInsideSpatial(spatial, p)) continue;
                            candidates.Add(p);
                        }
                    }
                    catch
                    {
                        // ignore problematic grid intersections
                    }
                }
            }

            return MergeDistinctPoints(candidates, new List<XYZ>());
        }

        private static List<XYZ> BuildSpatialSampleCandidates(SpatialElement spatial, BoundingBoxXYZ bb, double z, double minSeparationFeet)
        {
            var candidates = new List<XYZ>();
            var step = Math.Max(1.0, minSeparationFeet / 2.0);
            for (double x = bb.Min.X; x <= bb.Max.X + 1e-6; x += step)
            {
                for (double y = bb.Min.Y; y <= bb.Max.Y + 1e-6; y += step)
                {
                    var p = new XYZ(x, y, z);
                    if (IsPointInsideSpatial(spatial, p)) candidates.Add(p);
                }
            }
            return candidates;
        }

        private static List<XYZ> MergeDistinctPoints(List<XYZ> primary, List<XYZ> secondary)
        {
            var merged = new List<XYZ>();
            var seen = new HashSet<string>(StringComparer.Ordinal);

            Action<IEnumerable<XYZ>> addRange = list =>
            {
                foreach (var p in list)
                {
                    var key = $"{Math.Round(p.X, 3)}|{Math.Round(p.Y, 3)}|{Math.Round(p.Z, 3)}";
                    if (!seen.Add(key)) continue;
                    merged.Add(p);
                }
            };

            addRange(primary ?? new List<XYZ>());
            addRange(secondary ?? new List<XYZ>());
            return merged;
        }

        private static bool IsPointClearFromExisting(XYZ point, List<XYZ> existingPoints, double minClearanceFeet)
        {
            if (existingPoints == null || existingPoints.Count == 0) return true;
            var clearance = Math.Max(0.0, minClearanceFeet);
            foreach (var ep in existingPoints)
            {
                if (ep == null) continue;
                if (point.DistanceTo(ep) < clearance) return false;
            }
            return true;
        }

        private static string BuildTerminalMarkerPrefix(long spatialId, string label)
        {
            return $"airflow-qa:terminal:{spatialId}:{NormalizeHeader(label)}";
        }

        private static int RemoveAutoPlacedTerminals(Document doc, string markerPrefix)
        {
            var toDelete = new List<ElementId>();
            foreach (var e in new FilteredElementCollector(doc)
                .WhereElementIsNotElementType()
                .OfCategory(BuiltInCategory.OST_DuctTerminal))
            {
                var comments = ReadStringParameterWithTypeFallback(doc, e, "Comments");
                if (string.IsNullOrWhiteSpace(comments)) continue;
                if (!comments.StartsWith(markerPrefix, StringComparison.OrdinalIgnoreCase)) continue;
                toDelete.Add(e.Id);
            }

            if (toDelete.Count > 0)
            {
                try { doc.Delete(toDelete); } catch { }
            }

            return toDelete.Count;
        }

        private static object TagElementsInView(
            Document doc,
            View view,
            List<long> elementIds,
            string? tagTypeNameContains,
            bool onlyUntagged,
            bool addLeader,
            double offsetFeet,
            bool dryRun)
        {
            var candidateIds = elementIds.Where(x => x > 0).Distinct().ToList();
            var alreadyTagged = GetAlreadyTaggedElementIdsInView(doc, view);
            var toTag = onlyUntagged
                ? candidateIds.Where(id => !alreadyTagged.Contains(id)).ToList()
                : candidateIds;

            var planned = new List<object>();
            var created = new List<object>();
            var failed = new List<object>();

            var tagTypeId = ResolveDuctTerminalTagTypeId(doc, tagTypeNameContains);
            foreach (var id in toTag)
            {
                var e = doc.GetElement(RevitBridge.Common.ElementIdCompat.Create(id));
                if (e == null) continue;

                var basePoint = ResolveElementLocationPoint(e) ?? XYZ.Zero;
                var tagPoint = new XYZ(basePoint.X + offsetFeet, basePoint.Y + offsetFeet, basePoint.Z);

                planned.Add(new { elementId = id, point = new[] { tagPoint.X, tagPoint.Y, tagPoint.Z }, tagTypeId = tagTypeId == ElementId.InvalidElementId ? (long?)null : RevitBridge.Common.ElementIdCompat.GetValue(tagTypeId) });
                if (dryRun) continue;

                try
                {
                    var tag = IndependentTag.Create(doc, view.Id, new Reference(e), addLeader, TagMode.TM_ADDBY_CATEGORY, TagOrientation.Horizontal, tagPoint);
                    if (tag != null && tagTypeId != ElementId.InvalidElementId)
                    {
                        try { tag.ChangeTypeId(tagTypeId); } catch { }
                    }

                    created.Add(new
                    {
                        elementId = id,
                        tagId = RevitBridge.Common.ElementIdCompat.GetValue(tag?.Id),
                        tagTypeId = tagTypeId == ElementId.InvalidElementId ? (long?)null : RevitBridge.Common.ElementIdCompat.GetValue(tagTypeId)
                    });
                }
                catch (Exception ex)
                {
                    failed.Add(new { elementId = id, error = ex.Message });
                }
            }

            return new
            {
                viewId = RevitBridge.Common.ElementIdCompat.GetValue(view.Id),
                candidates = candidateIds.Count,
                skippedAlreadyTagged = candidateIds.Count - toTag.Count,
                tagged = dryRun ? planned.Count : created.Count,
                failed = failed.Count,
                planned,
                created,
                failures = failed
            };
        }

        private static HashSet<long> GetAlreadyTaggedElementIdsInView(Document doc, View view)
        {
            var ids = new HashSet<long>();
            foreach (var tag in new FilteredElementCollector(doc, view.Id).OfClass(typeof(IndependentTag)).Cast<IndependentTag>())
            {
                var tagged = TryReadTaggedLocalElementId(tag);
                if (tagged.HasValue && tagged.Value > 0) ids.Add(tagged.Value);
            }
            return ids;
        }

        private static long? TryReadTaggedLocalElementId(IndependentTag tag)
        {
            try
            {
                var p = tag.GetType().GetProperty("TaggedLocalElementId");
                if (p != null)
                {
                    var v = p.GetValue(tag) as ElementId;
                    if (v != null && v != ElementId.InvalidElementId) return RevitBridge.Common.ElementIdCompat.GetValue(v);
                }
            }
            catch { }

            try
            {
                var m = tag.GetType().GetMethod("GetTaggedLocalElementIds", Type.EmptyTypes);
                if (m != null)
                {
                    var value = m.Invoke(tag, null);
                    if (value is System.Collections.IEnumerable seq)
                    {
                        foreach (var item in seq)
                        {
                            if (item is ElementId id && id != ElementId.InvalidElementId) return RevitBridge.Common.ElementIdCompat.GetValue(id);
                        }
                    }
                }
            }
            catch { }

            return null;
        }

        private static ElementId ResolveDuctTerminalTagTypeId(Document doc, string? typeNameContains)
        {
            var token = (typeNameContains ?? "").Trim();
            var all = new FilteredElementCollector(doc)
                .OfClass(typeof(FamilySymbol))
                .OfCategory(BuiltInCategory.OST_DuctTerminalTags)
                .Cast<FamilySymbol>()
                .ToList();

            if (all.Count == 0) return ElementId.InvalidElementId;
            if (token.Length == 0) return all[0].Id;

            var exact = all.FirstOrDefault(s => (s.Name ?? "").Equals(token, StringComparison.OrdinalIgnoreCase));
            if (exact != null) return exact.Id;

            var contains = all.FirstOrDefault(s =>
                (s.Name ?? "").IndexOf(token, StringComparison.OrdinalIgnoreCase) >= 0 ||
                (s.FamilyName ?? "").IndexOf(token, StringComparison.OrdinalIgnoreCase) >= 0);
            return contains?.Id ?? all[0].Id;
        }

        private static int ReadIntProperty(object obj, string name)
        {
            try
            {
                var p = obj.GetType().GetProperty(name);
                var v = p?.GetValue(obj);
                if (v is int i) return i;
                if (v is long l) return (int)l;
            }
            catch { }
            return 0;
        }

        private static string BuildPressureMarkerPrefix(long spatialId)
        {
            return $"airflow-qa:pressure:{spatialId}";
        }

        private static List<object> RemoveAutoPressureRegions(Document doc, View view, string markerPrefix)
        {
            var removed = new List<object>();
            var toDelete = new List<ElementId>();

            foreach (var e in new FilteredElementCollector(doc, view.Id).OfClass(typeof(FilledRegion)).Cast<FilledRegion>())
            {
                var comments = ReadStringParameterWithTypeFallback(doc, e, "Comments");
                if (string.IsNullOrWhiteSpace(comments)) continue;
                if (!comments.StartsWith(markerPrefix, StringComparison.OrdinalIgnoreCase)) continue;
                toDelete.Add(e.Id);
                removed.Add(new { regionId = RevitBridge.Common.ElementIdCompat.GetValue(e.Id), comments });
            }

            if (toDelete.Count > 0)
            {
                try { doc.Delete(toDelete); } catch { }
            }

            return removed;
        }

        private static bool TryBuildSpatialBoundaryLoops(SpatialElement spatial, out List<CurveLoop> loops, out string? warning)
        {
            loops = new List<CurveLoop>();
            warning = null;
            try
            {
                var options = new SpatialElementBoundaryOptions { SpatialElementBoundaryLocation = SpatialElementBoundaryLocation.Finish };
                var boundaries = spatial.GetBoundarySegments(options);
                if (boundaries == null || boundaries.Count == 0)
                {
                    warning = "No boundary segments returned.";
                    return false;
                }

                foreach (var loop in boundaries)
                {
                    if (loop == null || loop.Count == 0) continue;
                    var cl = new CurveLoop();
                    foreach (var seg in loop)
                    {
                        if (seg?.GetCurve() == null) continue;
                        cl.Append(seg.GetCurve());
                    }
                    if (cl.Count() >= 3) loops.Add(cl);
                }

                if (loops.Count == 0)
                {
                    warning = "No usable curve loops resolved.";
                    return false;
                }

                return true;
            }
            catch (Exception ex)
            {
                warning = ex.Message;
                return false;
            }
        }

        private static ElementId ResolveSolidFillPatternId(Document doc)
        {
            var solid = new FilteredElementCollector(doc)
                .OfClass(typeof(FillPatternElement))
                .Cast<FillPatternElement>()
                .FirstOrDefault(fp =>
                {
                    try { return fp.GetFillPattern()?.IsSolidFill == true; }
                    catch { return false; }
                });
            return solid?.Id ?? ElementId.InvalidElementId;
        }

        private static Color ParseHexColorOrDefault(string? hex, Color fallback)
        {
            var t = (hex ?? "").Trim();
            if (t.StartsWith("#")) t = t.Substring(1);
            if (t.Length != 6) return fallback;

            try
            {
                var r = Convert.ToByte(t.Substring(0, 2), 16);
                var g = Convert.ToByte(t.Substring(2, 2), 16);
                var b = Convert.ToByte(t.Substring(4, 2), 16);
                return new Color(r, g, b);
            }
            catch
            {
                return fallback;
            }
        }

        private static string ColorToHex(Color c)
        {
            return $"#{c.Red:X2}{c.Green:X2}{c.Blue:X2}";
        }

        private static XYZ? ResolveElementLocationPoint(Element e)
        {
            try
            {
                if (e.Location is LocationPoint lp && lp.Point != null) return lp.Point;
            }
            catch { }

            try
            {
                if (e.Location is LocationCurve lc && lc.Curve != null)
                {
                    return lc.Curve.Evaluate(0.5, true);
                }
            }
            catch { }

            try
            {
                var bb = e.get_BoundingBox(null);
                if (bb != null) return (bb.Min + bb.Max) * 0.5;
            }
            catch { }

            return null;
        }

        private static bool IsPointInsideSpatial(SpatialElement spatial, XYZ p)
        {
            try
            {
                if (spatial is Room r) return r.IsPointInRoom(p);
                if (spatial is Space s) return s.IsPointInSpace(p);
            }
            catch { }
            return false;
        }

        private static int ClampInt(int value, int min, int max)
        {
            if (value < min) return min;
            if (value > max) return max;
            return value;
        }

        private static bool HasStatus(object row, string status)
        {
            try
            {
                var prop = row.GetType().GetProperty("status");
                var value = prop?.GetValue(row) as string;
                return string.Equals(value, status, StringComparison.OrdinalIgnoreCase);
            }
            catch
            {
                return false;
            }
        }

        private static bool HasFlag(object row, string propertyName)
        {
            try
            {
                var prop = row.GetType().GetProperty(propertyName);
                var value = prop?.GetValue(row);
                return value is bool b && b;
            }
            catch
            {
                return false;
            }
        }

        private static bool IsScheduledMissing(object row)
        {
            try
            {
                var sourceProp = row.GetType().GetProperty("source");
                var source = sourceProp?.GetValue(row);
                if (source == null) return true;
                var flowProp = source.GetType().GetProperty("scheduledFlow");
                var flow = flowProp?.GetValue(source);
                return flow == null;
            }
            catch
            {
                return true;
            }
        }

        private static bool HasError(object row)
        {
            try
            {
                var prop = row.GetType().GetProperty("error") ?? row.GetType().GetProperty("writeError");
                var value = prop?.GetValue(row) as string;
                return !string.IsNullOrWhiteSpace(value);
            }
            catch
            {
                return false;
            }
        }
    }
}
