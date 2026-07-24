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
    public sealed partial class MepWorkflowsHandler : IRequestHandler
    {
        private sealed class BoxSpec
        {
            public XYZ Min { get; set; } = XYZ.Zero;
            public XYZ Max { get; set; } = XYZ.Zero;
        }

        public sealed class ParameterWriteSpec
        {
            public string? parameterName { get; set; }
            public string? value { get; set; }
        }

        public sealed class FlexRoutePoint
        {
            public double x { get; set; }
            public double y { get; set; }
            public double z { get; set; }
        }

        public sealed class Params
        {
            public string? action { get; set; }
            public bool? dryRun { get; set; }
            public int? max { get; set; }

            public long? viewId { get; set; }
            public List<long>? sourceElementIds { get; set; }
            public List<string>? sourceCategories { get; set; }
            public string? categoryName { get; set; }

            public string? name { get; set; }
            public string? scheduleName { get; set; }
            public long? levelId { get; set; }
            public string? levelName { get; set; }
            public string? templateName { get; set; }
            public string? roomNumber { get; set; }

            public List<ParameterWriteSpec>? parameterWrites { get; set; }
            public string? systemTypeName { get; set; }
            public bool? tagUpdatedElements { get; set; }
            public string? tagTypeNameContains { get; set; }
            public bool? onlyTagUntagged { get; set; }
            public bool? addTagLeader { get; set; }
            public double? tagOffsetFeet { get; set; }

            public List<string>? slopeParameterNames { get; set; }
            public double? minSlope { get; set; }
            public double? maxSlope { get; set; }
            public double? slopeTolerance { get; set; }

            public double? paddingFeet { get; set; }
            public double? sectionWidthFeet { get; set; }
            public double? sectionHeightFeet { get; set; }
            public double? sectionDepthFeet { get; set; }
            public int? maxSections { get; set; }

            public string? familyName { get; set; }
            public string? symbolName { get; set; }
            public double? spacingFeet { get; set; }
            public double? startOffsetFeet { get; set; }
            public double? endOffsetFeet { get; set; }
            public double? idempotencyToleranceFeet { get; set; }

            public long? sourceViewId { get; set; }
            public long? startElementId { get; set; }
            public long? endElementId { get; set; }
            public long? startConnectorId { get; set; }
            public double[]? expectedStartOriginXyz { get; set; }
            public double? originToleranceFt { get; set; }
            public long? equipmentElementId { get; set; }
            public List<long>? terminalElementIds { get; set; }
            public List<long>? equipmentElementIds { get; set; }
            public string? ductTypeName { get; set; }
            public string? ductSize { get; set; }
            public long? flexDuctTypeId { get; set; }
            public string? flexDuctTypeName { get; set; }
            public List<FlexRoutePoint>? flexPoints { get; set; }
            public double[]? flexStartTangentXyz { get; set; }
            public double[]? flexEndTangentXyz { get; set; }
            public long? worksetId { get; set; }
            public string? worksetName { get; set; }
            public bool? verify { get; set; }
            public int? maxBranches { get; set; }
            public int? maxElbowsPerBranch { get; set; }
            public double? maxLengthFeet { get; set; }
            public bool? createSpaceTags { get; set; }
            public bool? annotateEquipment { get; set; }
            public double? x { get; set; }
            public double? y { get; set; }
            public double? z { get; set; }
        }

        private static readonly Regex NumberRegex = new Regex(@"[-+]?\d*\.?\d+", RegexOptions.Compiled);
        private static readonly string[] DefaultSlopeParameterNames = { "Slope", "Duct Slope" };

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
                "set_duct_parameter_set" => Task.FromResult(SetDuctParameterSet(doc, p)),
                "audit_duct_slope" => Task.FromResult(AuditDuctSlope(doc, p)),
                "create_duct_fitting_schedule" => Task.FromResult(CreateDuctFittingSchedule(app, p)),
                "create_mechanical_plan" => Task.FromResult(CreateMechanicalPlan(app, p)),
                "create_coordination_3d_view" => Task.FromResult(CreateCoordination3dView(app, doc, p)),
                "create_sections_along_ducts" => Task.FromResult(CreateSectionsAlongDucts(app, doc, p)),
                "place_family_along_ducts" => Task.FromResult(PlaceFamilyAlongDucts(app, doc, p)),
                "connect_elements_with_duct" => Task.FromResult(ConnectElementsWithDuct(app, doc, p, "duct")),
                "connect_elements_with_elbow" => Task.FromResult(ConnectElementsWithDuct(app, doc, p, "elbow")),
                "connect_elements_with_transition" => Task.FromResult(ConnectElementsWithDuct(app, doc, p, "transition")),
                "connect_elements_with_flex" => Task.FromResult(ConnectElementsWithDuct(app, doc, p, "flex")),
                "create_open_flex_from_element" => Task.FromResult(CreateOpenFlexFromElement(doc, p)),
                "route_terminals_to_equipment" => Task.FromResult(RouteTerminalsToEquipment(app, doc, p)),
                "place_equipment_and_connect" => Task.FromResult(PlaceEquipmentAndConnect(app, doc, p)),
                "create_riser_offset" => Task.FromResult(CreateRiserOffset(app, doc, p)),
                "ensure_spaces_and_tag" => Task.FromResult(EnsureSpacesAndTag(app, doc, p)),
                "create_hvac_schematic" => Task.FromResult(CreateHvacSchematic(app, doc, p)),
                "duplicate_3d_with_section_box" => Task.FromResult(Duplicate3dWithSectionBox(app, doc, p)),
                "create_dependent_with_crop" => Task.FromResult(CreateDependentWithCrop(app, doc, p)),
                _ => throw new InvalidOperationException("mep-workflows.action must be one of: set_duct_parameter_set, audit_duct_slope, create_duct_fitting_schedule, create_mechanical_plan, create_coordination_3d_view, create_sections_along_ducts, place_family_along_ducts, connect_elements_with_duct, connect_elements_with_elbow, connect_elements_with_transition, connect_elements_with_flex, create_open_flex_from_element, route_terminals_to_equipment, place_equipment_and_connect, create_riser_offset, ensure_spaces_and_tag, create_hvac_schematic, duplicate_3d_with_section_box, create_dependent_with_crop.")
            };
        }

        private static object SetDuctParameterSet(Document doc, Params p)
        {
            var dryRun = p.dryRun ?? false;
            var max = ClampInt(p.max ?? 5000, 1, 50000);
            var writes = (p.parameterWrites ?? new List<ParameterWriteSpec>())
                .Where(x => x != null && !string.IsNullOrWhiteSpace(x.parameterName))
                .Select(x => new ParameterWriteSpec
                {
                    parameterName = (x.parameterName ?? "").Trim(),
                    value = x.value ?? ""
                })
                .ToList();

            var systemTypeName = (p.systemTypeName ?? "").Trim();
            if (writes.Count == 0 && systemTypeName.Length == 0)
                throw new InvalidOperationException("set_duct_parameter_set requires parameterWrites and/or systemTypeName.");

            var targets = ResolveTargetElements(doc, p, new[] { BuiltInCategory.OST_DuctCurves }, max);
            var targetIds = targets.Select(e => ElementIdCompat.GetValue(e.Id)).Distinct().ToList();

            var systemType = ResolveSystemType(doc, systemTypeName);
            var warnings = new List<string>();
            var writeRows = new List<object>();
            var changed = 0;
            var tagResult = (object?)null;

            if (dryRun)
            {
                foreach (var e in targets)
                {
                    foreach (var w in writes)
                    {
                        var param = e.LookupParameter(w.parameterName ?? "");
                        writeRows.Add(new
                        {
                            elementId = ElementIdCompat.GetValue(e.Id),
                            parameterName = w.parameterName,
                            ok = param != null,
                            writable = param != null && !param.IsReadOnly,
                            plannedValue = w.value,
                            current = param == null ? null : ParameterValueUtil.SnapshotForWire(param)
                        });
                    }
                }

                return new
                {
                    status = "Dry Run",
                    action = "set_duct_parameter_set",
                    dryRun = true,
                    targetCount = targetIds.Count,
                    targets = targetIds,
                    writes = writeRows,
                    systemType = systemType == null ? null : new { id = ElementIdCompat.GetValue(systemType.Id), name = systemType.Name },
                    tagPlanned = p.tagUpdatedElements == true,
                    warnings
                };
            }

            using (var tx = new Transaction(doc, "MEP Workflows - Set Duct Parameter Set"))
            {
                tx.Start();

                foreach (var e in targets)
                {
                    var eid = ElementIdCompat.GetValue(e.Id);
                    foreach (var w in writes)
                    {
                        var paramName = (w.parameterName ?? "").Trim();
                        var param = e.LookupParameter(paramName);
                        if (param == null)
                        {
                            writeRows.Add(new { elementId = eid, parameterName = paramName, ok = false, changed = false, error = "Parameter not found." });
                            continue;
                        }

                        var before = ParameterValueUtil.SnapshotForWire(param);
                        if (!TrySetParameterFromString(doc, param, w.value ?? "", out var didChange, out var err))
                        {
                            writeRows.Add(new { elementId = eid, parameterName = paramName, ok = false, changed = false, error = err, before, after = before });
                            continue;
                        }

                        var after = ParameterValueUtil.SnapshotForWire(param);
                        if (didChange) changed++;
                        writeRows.Add(new { elementId = eid, parameterName = paramName, ok = true, changed = didChange, before, after });
                    }

                    if (systemType != null)
                    {
                        try
                        {
                            var sysParam = e.get_Parameter(BuiltInParameter.RBS_DUCT_SYSTEM_TYPE_PARAM);
                            if (sysParam == null || sysParam.IsReadOnly)
                            {
                                writeRows.Add(new
                                {
                                    elementId = eid,
                                    parameterName = "RBS_DUCT_SYSTEM_TYPE_PARAM",
                                    ok = false,
                                    changed = false,
                                    error = "System type parameter missing or read-only."
                                });
                            }
                            else
                            {
                                var beforeSys = ParameterValueUtil.SnapshotForWire(sysParam);
                                var beforeType = sysParam.AsElementId();
                                var beforeValue = ElementIdCompat.GetValue(beforeType);
                                var nextValue = ElementIdCompat.GetValue(systemType.Id);
                                var didChange = beforeValue != nextValue && sysParam.Set(systemType.Id);
                                var afterSys = ParameterValueUtil.SnapshotForWire(sysParam);
                                if (didChange) changed++;
                                writeRows.Add(new
                                {
                                    elementId = eid,
                                    parameterName = "RBS_DUCT_SYSTEM_TYPE_PARAM",
                                    ok = true,
                                    changed = didChange,
                                    before = beforeSys,
                                    after = afterSys
                                });
                            }
                        }
                        catch (Exception ex)
                        {
                            writeRows.Add(new
                            {
                                elementId = eid,
                                parameterName = "RBS_DUCT_SYSTEM_TYPE_PARAM",
                                ok = false,
                                changed = false,
                                error = ex.Message
                            });
                        }
                    }
                }

                if (p.tagUpdatedElements == true && targetIds.Count > 0)
                {
                    var view = ResolveView(doc, p.viewId);
                    if (view != null)
                    {
                        tagResult = TagElementsInView(doc, view, targetIds, p.tagTypeNameContains, p.onlyTagUntagged ?? true, p.addTagLeader ?? false, p.tagOffsetFeet ?? 1.5, dryRun: false);
                    }
                    else
                    {
                        warnings.Add("tagUpdatedElements requested but no valid target view was found.");
                    }
                }

                tx.Commit();
            }

            return new
            {
                status = "Applied",
                action = "set_duct_parameter_set",
                dryRun = false,
                targetCount = targetIds.Count,
                targets = targetIds,
                changedCount = changed,
                writes = writeRows,
                systemType = systemType == null ? null : new { id = ElementIdCompat.GetValue(systemType.Id), name = systemType.Name },
                tagResult,
                warnings
            };
        }

        private static object AuditDuctSlope(Document doc, Params p)
        {
            var max = ClampInt(p.max ?? 5000, 1, 50000);
            var minSlope = p.minSlope ?? double.MinValue;
            var maxSlope = p.maxSlope ?? double.MaxValue;
            var tol = Math.Max(0.0, p.slopeTolerance ?? 0.0);
            var names = NormalizeStringList(p.slopeParameterNames, DefaultSlopeParameterNames).ToList();

            var targets = ResolveTargetElements(doc, p, new[] { BuiltInCategory.OST_DuctCurves }, max);
            var rows = new List<object>();
            var violationCount = 0;
            var missingCount = 0;

            foreach (var e in targets)
            {
                var slope = ReadSlopeValue(doc, e, names, out var parameterName, out var scope, out var rawValue);
                var missing = !slope.HasValue;
                var violation = false;
                if (slope.HasValue)
                {
                    if (slope.Value < minSlope - tol) violation = true;
                    if (slope.Value > maxSlope + tol) violation = true;
                }

                if (missing) missingCount++;
                if (violation) violationCount++;

                rows.Add(new
                {
                    elementId = ElementIdCompat.GetValue(e.Id),
                    category = GetCategoryToken(e),
                    slope = slope,
                    parameterName,
                    parameterScope = scope,
                    rawValue,
                    missing,
                    violation
                });
            }

            return new
            {
                status = "Ok",
                action = "audit_duct_slope",
                targetCount = targets.Count,
                violationCount,
                missingCount,
                thresholds = new { minSlope = p.minSlope, maxSlope = p.maxSlope, slopeTolerance = tol },
                results = rows
            };
        }

        private static object CreateDuctFittingSchedule(UIApplication app, Params p)
        {
            var scheduleName = (p.scheduleName ?? p.name ?? "").Trim();
            if (scheduleName.Length == 0) scheduleName = $"Duct Fittings - {DateTime.Now:yyyyMMddHHmmss}";
            var dryRun = p.dryRun ?? false;

            var createRequest = new
            {
                name = scheduleName,
                kind = "regular",
                category = "OST_DuctFitting",
                includeLinkedFiles = false,
                dryRun
            };

            var createResult = new CreateScheduleHandler().Handle(app, JsonSerializer.Serialize(createRequest)).GetAwaiter().GetResult();
            var scheduleId = TryReadLong(createResult, "viewId");

            object? configureResult = null;
            if (!dryRun && scheduleId > 0)
            {
                var configureRequest = new
                {
                    scheduleId,
                    addFields = new[] { "Family and Type", "Count", "Size" },
                    sortGroup = new[]
                    {
                        new
                        {
                            field = "Family and Type",
                            ascending = true,
                            showHeader = true
                        }
                    },
                    showGrandTotals = true,
                    replaceSortGroup = true,
                    dryRun = false
                };

                configureResult = new ConfigureScheduleHandler().Handle(app, JsonSerializer.Serialize(configureRequest)).GetAwaiter().GetResult();
            }

            return new
            {
                status = dryRun ? "Dry Run" : "Applied",
                action = "create_duct_fitting_schedule",
                scheduleName,
                scheduleId = scheduleId > 0 ? scheduleId : (long?)null,
                createResult,
                configureResult
            };
        }

        private static object CreateMechanicalPlan(UIApplication app, Params p)
        {
            var dryRun = p.dryRun ?? false;
            var request = new CreateViewHandler.Params
            {
                action = "create_floor_plan",
                name = p.name,
                levelId = p.levelId,
                levelName = p.levelName,
                planType = "engineering",
                discipline = "Mechanical",
                templateName = p.templateName,
                dryRun = dryRun
            };

            var result = new CreateViewHandler().Handle(app, JsonSerializer.Serialize(request)).GetAwaiter().GetResult();
            return new
            {
                status = dryRun ? "Dry Run" : "Applied",
                action = "create_mechanical_plan",
                result
            };
        }

        private static object CreateCoordination3dView(UIApplication app, Document doc, Params p)
        {
            var dryRun = p.dryRun ?? false;
            var viewName = (p.name ?? "").Trim();
            if (viewName.Length == 0) viewName = $"Coordination 3D - {DateTime.Now:yyyyMMddHHmmss}";
            var padding = Math.Max(0.0, p.paddingFeet ?? 2.0);

            var createReq = new CreateViewHandler.Params
            {
                action = "create_3d",
                name = viewName,
                perspective = false,
                templateName = p.templateName,
                dryRun = dryRun
            };

            var createResult = new CreateViewHandler().Handle(app, JsonSerializer.Serialize(createReq)).GetAwaiter().GetResult();
            if (dryRun)
            {
                return new
                {
                    status = "Dry Run",
                    action = "create_coordination_3d_view",
                    viewName,
                    createResult
                };
            }

            var viewId = TryReadLong(createResult, "view.id");
            if (viewId <= 0) throw new InvalidOperationException("create_coordination_3d_view failed to resolve created view id.");

            var targetBox = ResolveCoordinationBox(doc, p, out var sourceSummary);
            if (targetBox == null)
            {
                return new
                {
                    status = "AppliedWithWarnings",
                    action = "create_coordination_3d_view",
                    viewId,
                    viewName,
                    warning = "No room/source bounding box resolved; created view without section box.",
                    createResult,
                    sourceSummary
                };
            }

            var min = new XYZ(targetBox.Min.X - padding, targetBox.Min.Y - padding, targetBox.Min.Z - padding);
            var max = new XYZ(targetBox.Max.X + padding, targetBox.Max.Y + padding, targetBox.Max.Z + padding);
            var visReq = new ViewVisibilityHandler.Params
            {
                viewId = viewId,
                action = "set_section_box",
                boxMin = new ViewVisibilityHandler.Point3 { x = min.X, y = min.Y, z = min.Z },
                boxMax = new ViewVisibilityHandler.Point3 { x = max.X, y = max.Y, z = max.Z },
                dryRun = false
            };
            var sectionResult = new ViewVisibilityHandler().Handle(app, JsonSerializer.Serialize(visReq)).GetAwaiter().GetResult();

            return new
            {
                status = "Applied",
                action = "create_coordination_3d_view",
                viewId,
                viewName,
                box = new
                {
                    min = new[] { min.X, min.Y, min.Z },
                    max = new[] { max.X, max.Y, max.Z }
                },
                sourceSummary,
                createResult,
                sectionResult
            };
        }

        private static object CreateSectionsAlongDucts(UIApplication app, Document doc, Params p)
        {
            var dryRun = p.dryRun ?? false;
            var maxSections = ClampInt(p.maxSections ?? 25, 1, 200);
            var sectionWidth = Math.Max(1.0, p.sectionWidthFeet ?? 12.0);
            var sectionHeight = Math.Max(1.0, p.sectionHeightFeet ?? 10.0);
            var sectionDepth = Math.Max(1.0, p.sectionDepthFeet ?? 8.0);
            var max = ClampInt(p.max ?? 5000, 1, 50000);

            var targets = ResolveTargetElements(doc, p, new[] { BuiltInCategory.OST_DuctCurves }, max)
                .OfType<Duct>()
                .ToList();

            var sections = new List<object>();
            var createdCount = 0;
            foreach (var duct in targets)
            {
                if (sections.Count >= maxSections) break;
                if (duct.Location is not LocationCurve lc || lc.Curve == null) continue;

                XYZ p1c;
                XYZ p2c;
                try
                {
                    p1c = lc.Curve.GetEndPoint(0);
                    p2c = lc.Curve.GetEndPoint(1);
                }
                catch
                {
                    continue;
                }

                var dir = (p2c - p1c);
                if (dir.GetLength() < 1e-6) continue;
                dir = dir.Normalize();
                var mid = (p1c + p2c) * 0.5;
                var perp = new XYZ(-dir.Y, dir.X, 0.0);
                if (perp.GetLength() < 1e-6) perp = XYZ.BasisX;
                perp = perp.Normalize();

                var halfWidth = sectionWidth * 0.5;
                var secP1 = mid - perp * halfWidth;
                var secP2 = mid + perp * halfWidth;
                var secName = (p.name ?? "Duct Section").Trim();
                if (secName.Length == 0) secName = "Duct Section";
                secName = $"{secName} {createdCount + 1:000}";

                var req = new CreateViewHandler.Params
                {
                    action = "create_section",
                    name = secName,
                    p1 = new CreateViewHandler.Point3 { x = secP1.X, y = secP1.Y, z = secP1.Z },
                    p2 = new CreateViewHandler.Point3 { x = secP2.X, y = secP2.Y, z = secP2.Z },
                    sectionHeight = sectionHeight,
                    sectionDepth = sectionDepth,
                    dryRun = dryRun
                };

                var result = new CreateViewHandler().Handle(app, JsonSerializer.Serialize(req)).GetAwaiter().GetResult();
                var viewId = TryReadLong(result, "view.id");
                if (viewId > 0) createdCount++;

                sections.Add(new
                {
                    sourceDuctId = ElementIdCompat.GetValue(duct.Id),
                    sectionName = secName,
                    sectionViewId = viewId > 0 ? viewId : (long?)null,
                    requestLine = new
                    {
                        p1 = new[] { secP1.X, secP1.Y, secP1.Z },
                        p2 = new[] { secP2.X, secP2.Y, secP2.Z }
                    },
                    result
                });
            }

            return new
            {
                status = dryRun ? "Dry Run" : "Applied",
                action = "create_sections_along_ducts",
                dryRun,
                targetDuctCount = targets.Count,
                requestedMaxSections = maxSections,
                createdCount,
                sections
            };
        }

        private static object PlaceFamilyAlongDucts(UIApplication app, Document doc, Params p)
        {
            var dryRun = p.dryRun ?? false;
            var max = ClampInt(p.max ?? 5000, 1, 50000);
            var spacing = Math.Max(0.5, p.spacingFeet ?? 8.0);
            var startOffset = Math.Max(0.0, p.startOffsetFeet ?? 0.0);
            var endOffset = Math.Max(0.0, p.endOffsetFeet ?? 0.0);
            var symbolName = (p.symbolName ?? "").Trim();
            if (symbolName.Length == 0) throw new InvalidOperationException("place_family_along_ducts requires symbolName.");

            var targets = ResolveTargetElements(doc, p, new[] { BuiltInCategory.OST_DuctCurves }, max)
                .OfType<Duct>()
                .ToList();

            var levels = new FilteredElementCollector(doc)
                .OfClass(typeof(Level))
                .Cast<Level>()
                .ToList();
            if (levels.Count == 0) throw new InvalidOperationException("No levels found for placement.");

            var defaultLevel = ResolveLevel(doc, p.levelId, p.levelName) ?? levels.FirstOrDefault();
            if (defaultLevel == null) throw new InvalidOperationException("No valid level found for placement.");

            var instances = new List<object>();
            foreach (var duct in targets)
            {
                if (duct.Location is not LocationCurve lc || lc.Curve == null) continue;
                var curve = lc.Curve;
                var length = curve.Length;
                if (length <= 1e-6) continue;
                var from = Math.Min(length, startOffset);
                var to = Math.Max(from, length - endOffset);
                if (to - from < 1e-6) continue;

                for (var dist = from; dist <= to + 1e-6; dist += spacing)
                {
                    var t = length <= 1e-6 ? 0.0 : Math.Min(1.0, Math.Max(0.0, dist / length));
                    XYZ pt;
                    try { pt = curve.Evaluate(t, true); }
                    catch { continue; }

                    var level = ResolveNearestLevel(levels, pt.Z) ?? defaultLevel;
                    instances.Add(new
                    {
                        levelName = level.Name,
                        x = pt.X,
                        y = pt.Y,
                        z = pt.Z
                    });
                    if (instances.Count >= max) break;
                }
                if (instances.Count >= max) break;
            }

            var request = new
            {
                levelName = defaultLevel.Name,
                familyName = string.IsNullOrWhiteSpace(p.familyName) ? null : p.familyName!.Trim(),
                symbolName,
                instances,
                dryRun,
                behavior = "bestEffort",
                idempotency = new
                {
                    enabled = true,
                    toleranceFt = Math.Max(0.0, p.idempotencyToleranceFeet ?? 0.05)
                }
            };

            var placementResult = new PlaceFamiliesHandler().Handle(app, JsonSerializer.Serialize(request)).GetAwaiter().GetResult();
            return new
            {
                status = dryRun ? "Dry Run" : "Applied",
                action = "place_family_along_ducts",
                dryRun,
                targetDuctCount = targets.Count,
                plannedInstanceCount = instances.Count,
                request = new
                {
                    familyName = request.familyName,
                    symbolName = request.symbolName,
                    spacingFeet = spacing,
                    startOffsetFeet = startOffset,
                    endOffsetFeet = endOffset,
                    idempotencyToleranceFeet = request.idempotency.toleranceFt
                },
                placementResult
            };
        }

        private static View? ResolveView(Document doc, long? viewId)
        {
            if (viewId.HasValue && viewId.Value > 0)
            {
                return doc.GetElement(ElementIdCompat.Create(viewId.Value)) as View;
            }
            return doc.ActiveView;
        }

        private static List<Element> ResolveTargetElements(Document doc, Params p, IEnumerable<BuiltInCategory> fallbackCategories, int max)
        {
            var idSet = new HashSet<long>();
            var outList = new List<Element>();

            foreach (var id in (p.sourceElementIds ?? new List<long>()).Where(x => x > 0))
            {
                if (!idSet.Add(id)) continue;
                var e = doc.GetElement(ElementIdCompat.Create(id));
                if (e != null) outList.Add(e);
                if (outList.Count >= max) return outList;
            }
            if (outList.Count > 0) return outList;

            var categories = new List<BuiltInCategory>();
            foreach (var c in (p.sourceCategories ?? new List<string>()))
            {
                if (TryResolveCategory(doc, c, out var bic)) categories.Add(bic);
            }
            if (categories.Count == 0 && !string.IsNullOrWhiteSpace(p.categoryName))
            {
                if (TryResolveCategory(doc, p.categoryName!, out var bic)) categories.Add(bic);
            }
            if (categories.Count == 0) categories.AddRange(fallbackCategories);
            categories = categories.Distinct().ToList();

            var view = ResolveView(doc, p.viewId);
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

            foreach (var e in collector.WhereElementIsNotElementType())
            {
                if (e == null) continue;
                var catId = ElementIdCompat.GetValue(e.Category?.Id);
                if (catId == 0) continue;
                if (!categories.Any(x => (long)(int)x == catId)) continue;
                outList.Add(e);
                if (outList.Count >= max) break;
            }

            return outList;
        }

        private static string GetCategoryToken(Element e)
        {
            try
            {
                var id = ElementIdCompat.GetValue(e?.Category?.Id);
                if (id != 0 && id >= int.MinValue && id <= int.MaxValue)
                {
                    var bic = (BuiltInCategory)(int)id;
                    if (Enum.IsDefined(typeof(BuiltInCategory), bic))
                    {
                        return bic.ToString();
                    }
                }
            }
            catch
            {
                // ignored
            }

            return e?.Category?.Name ?? "Unknown";
        }

        private static bool TryResolveCategory(Document doc, string token, out BuiltInCategory bic)
        {
            bic = BuiltInCategory.INVALID;
            var t = (token ?? "").Trim();
            if (t.Length == 0) return false;

            if (Enum.TryParse(t, true, out bic) && bic != BuiltInCategory.INVALID) return true;

            var categories = doc.Settings?.Categories;
            if (categories == null) return false;
            foreach (Category c in categories)
            {
                if (!string.Equals(c.Name ?? "", t, StringComparison.OrdinalIgnoreCase)) continue;
                if (c.BuiltInCategory == BuiltInCategory.INVALID) continue;
                bic = c.BuiltInCategory;
                return true;
            }
            return false;
        }

        private static bool TrySetParameterFromString(Document doc, Parameter parameter, string raw, out bool changed, out string? error)
        {
            changed = false;
            error = null;
            if (parameter == null)
            {
                error = "Parameter not found.";
                return false;
            }
            if (parameter.IsReadOnly)
            {
                error = "Parameter is read-only.";
                return false;
            }

            try
            {
                if (parameter.StorageType == StorageType.String)
                {
                    var current = parameter.AsString() ?? "";
                    if (string.Equals(current, raw, StringComparison.Ordinal))
                    {
                        changed = false;
                        return true;
                    }
                    changed = parameter.Set(raw ?? "");
                    return changed;
                }

                if (parameter.StorageType == StorageType.Integer)
                {
                    if (!int.TryParse((raw ?? "").Trim(), NumberStyles.Integer, CultureInfo.InvariantCulture, out var iv) &&
                        !int.TryParse((raw ?? "").Trim(), NumberStyles.Integer, CultureInfo.CurrentCulture, out iv))
                    {
                        error = $"Invalid integer '{raw}'.";
                        return false;
                    }
                    var current = parameter.AsInteger();
                    if (current == iv)
                    {
                        changed = false;
                        return true;
                    }
                    changed = parameter.Set(iv);
                    return changed;
                }

                if (parameter.StorageType == StorageType.Double)
                {
                    var text = (raw ?? "").Trim();
                    if (text.Length == 0)
                    {
                        error = "Double parameter value is empty.";
                        return false;
                    }

                    if (TryParseDouble(text, out var dv))
                    {
                        var current = parameter.AsDouble();
                        if (Math.Abs(current - dv) <= 1e-9)
                        {
                            changed = false;
                            return true;
                        }
                        changed = parameter.Set(dv);
                        return changed;
                    }

                    try
                    {
                        var spec = parameter.Definition?.GetDataType();
                        if (spec != null && UnitFormatUtils.TryParse(doc.GetUnits(), spec, text, out var internalValue))
                        {
                            var current = parameter.AsDouble();
                            if (Math.Abs(current - internalValue) <= 1e-9)
                            {
                                changed = false;
                                return true;
                            }
                            changed = parameter.Set(internalValue);
                            return changed;
                        }
                    }
                    catch
                    {
                        // ignored
                    }

                    error = $"Invalid number '{raw}'.";
                    return false;
                }

                if (parameter.StorageType == StorageType.ElementId)
                {
                    if (!long.TryParse((raw ?? "").Trim(), NumberStyles.Integer, CultureInfo.InvariantCulture, out var lv))
                    {
                        error = $"Invalid element id '{raw}'.";
                        return false;
                    }
                    var current = ElementIdCompat.GetValue(parameter.AsElementId());
                    if (current == lv)
                    {
                        changed = false;
                        return true;
                    }
                    changed = parameter.Set(ElementIdCompat.Create(lv));
                    return changed;
                }

                error = $"Unsupported storage type {parameter.StorageType}.";
                return false;
            }
            catch (Exception ex)
            {
                error = ex.Message;
                return false;
            }
        }

        private static MEPSystemType? ResolveSystemType(Document doc, string systemTypeName)
        {
            var query = (systemTypeName ?? "").Trim();
            if (query.Length == 0) return null;

            var all = new FilteredElementCollector(doc)
                .OfClass(typeof(MEPSystemType))
                .Cast<MEPSystemType>()
                .ToList();

            var exact = all.FirstOrDefault(x => string.Equals((x.Name ?? "").Trim(), query, StringComparison.OrdinalIgnoreCase));
            if (exact != null) return exact;
            return all.FirstOrDefault(x => (x.Name ?? "").IndexOf(query, StringComparison.OrdinalIgnoreCase) >= 0);
        }

        private static double? ReadSlopeValue(Document doc, Element e, List<string> parameterNames, out string? parameterName, out string? scope, out string? rawValue)
        {
            parameterName = null;
            scope = null;
            rawValue = null;

            foreach (var name in parameterNames)
            {
                if (string.IsNullOrWhiteSpace(name)) continue;

                var inst = e.LookupParameter(name);
                if (TryReadParameterNumber(inst, out var vInst, out var rawInst))
                {
                    parameterName = name;
                    scope = "instance";
                    rawValue = rawInst;
                    return vInst;
                }

                var type = doc.GetElement(e.GetTypeId()) as ElementType;
                var pType = type?.LookupParameter(name);
                if (TryReadParameterNumber(pType, out var vType, out var rawType))
                {
                    parameterName = name;
                    scope = "type";
                    rawValue = rawType;
                    return vType;
                }
            }

            return null;
        }

        private static bool TryReadParameterNumber(Parameter? parameter, out double value, out string raw)
        {
            value = 0;
            raw = "";
            if (parameter == null) return false;
            try
            {
                raw = (parameter.AsString() ?? parameter.AsValueString() ?? "").Trim();
                if (TryExtractFirstNumber(raw, out value)) return true;

                if (parameter.StorageType == StorageType.Double)
                {
                    value = parameter.AsDouble();
                    return true;
                }
                if (parameter.StorageType == StorageType.Integer)
                {
                    value = parameter.AsInteger();
                    return true;
                }
            }
            catch
            {
                // ignored
            }
            return false;
        }

        private static bool TryExtractFirstNumber(string? input, out double value)
        {
            value = 0;
            var t = (input ?? "").Trim();
            if (t.Length == 0) return false;

            if (TryParseDouble(t, out value)) return true;
            var m = NumberRegex.Match(t);
            if (!m.Success) return false;
            return TryParseDouble(m.Value, out value);
        }

        private static bool TryParseDouble(string raw, out double value)
        {
            value = 0;
            return double.TryParse(raw, NumberStyles.Float, CultureInfo.InvariantCulture, out value) ||
                   double.TryParse(raw, NumberStyles.Float, CultureInfo.CurrentCulture, out value);
        }

        private static BoxSpec? ResolveCoordinationBox(Document doc, Params p, out object sourceSummary)
        {
            if (!string.IsNullOrWhiteSpace(p.roomNumber))
            {
                var target = NormalizeRoomNumber(p.roomNumber!);
                var spatial = FindSpatialByRoomNumber(doc, target);
                if (spatial != null)
                {
                    BoundingBoxXYZ? bb = null;
                    try { bb = spatial.get_BoundingBox(null); } catch { bb = null; }
                    if (bb != null)
                    {
                        sourceSummary = new
                        {
                            source = "roomNumber",
                            roomNumber = p.roomNumber,
                            normalizedRoomNumber = target,
                            spatialId = ElementIdCompat.GetValue(spatial.Id),
                            spatialKind = spatial is Space ? "Space" : "Room"
                        };
                        return new BoxSpec { Min = bb.Min, Max = bb.Max };
                    }
                }
            }

            var ids = (p.sourceElementIds ?? new List<long>())
                .Where(x => x > 0)
                .Distinct()
                .ToList();
            if (ids.Count > 0)
            {
                XYZ? min = null;
                XYZ? max = null;
                var valid = 0;
                foreach (var id in ids)
                {
                    var e = doc.GetElement(ElementIdCompat.Create(id));
                    if (e == null) continue;
                    BoundingBoxXYZ? bb = null;
                    try { bb = e.get_BoundingBox(null); } catch { bb = null; }
                    if (bb == null) continue;

                    valid++;
                    min = min == null
                        ? new XYZ(bb.Min.X, bb.Min.Y, bb.Min.Z)
                        : new XYZ(Math.Min(min.X, bb.Min.X), Math.Min(min.Y, bb.Min.Y), Math.Min(min.Z, bb.Min.Z));
                    max = max == null
                        ? new XYZ(bb.Max.X, bb.Max.Y, bb.Max.Z)
                        : new XYZ(Math.Max(max.X, bb.Max.X), Math.Max(max.Y, bb.Max.Y), Math.Max(max.Z, bb.Max.Z));
                }

                if (min != null && max != null)
                {
                    sourceSummary = new
                    {
                        source = "sourceElementIds",
                        requestedCount = ids.Count,
                        resolvedCount = valid
                    };
                    return new BoxSpec { Min = min, Max = max };
                }
            }

            sourceSummary = new
            {
                source = "none",
                roomNumber = p.roomNumber,
                sourceElementIdsCount = ids.Count
            };
            return null;
        }

        private static SpatialElement? FindSpatialByRoomNumber(Document doc, string normalizedRoomNumber)
        {
            var rooms = new FilteredElementCollector(doc)
                .OfCategory(BuiltInCategory.OST_Rooms)
                .WhereElementIsNotElementType()
                .Cast<SpatialElement>()
                .OfType<Room>();

            foreach (var room in rooms)
            {
                var num = NormalizeRoomNumber(room.Number ?? "");
                if (num.Length == 0) continue;
                if (num.Equals(normalizedRoomNumber, StringComparison.OrdinalIgnoreCase)) return room;
            }

            var spaces = new FilteredElementCollector(doc)
                .OfCategory(BuiltInCategory.OST_MEPSpaces)
                .WhereElementIsNotElementType()
                .Cast<SpatialElement>()
                .OfType<Space>();

            foreach (var space in spaces)
            {
                var num = NormalizeRoomNumber(space.Number ?? "");
                if (num.Length == 0) continue;
                if (num.Equals(normalizedRoomNumber, StringComparison.OrdinalIgnoreCase)) return space;
            }

            return null;
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

        private static Level? ResolveLevel(Document doc, long? levelId, string? levelName)
        {
            if (levelId.HasValue && levelId.Value > 0)
            {
                var byId = doc.GetElement(ElementIdCompat.Create(levelId.Value)) as Level;
                if (byId != null) return byId;
            }

            var name = (levelName ?? "").Trim();
            if (name.Length > 0)
            {
                return new FilteredElementCollector(doc)
                    .OfClass(typeof(Level))
                    .Cast<Level>()
                    .FirstOrDefault(x => string.Equals((x.Name ?? "").Trim(), name, StringComparison.OrdinalIgnoreCase));
            }

            return null;
        }

        private static Level? ResolveNearestLevel(List<Level> levels, double z)
        {
            if (levels == null || levels.Count == 0) return null;
            return levels.OrderBy(l => Math.Abs(l.Elevation - z)).FirstOrDefault();
        }

        private static object TagElementsInView(
            Document doc,
            View view,
            List<long> elementIds,
            string? tagTypeNameContains,
            bool onlyUntagged,
            bool addTagLeader,
            double offsetFeet,
            bool dryRun)
        {
            var existingTagged = GetTaggedElementIdsInView(doc, view);
            var toTag = onlyUntagged
                ? elementIds.Where(x => !existingTagged.Contains(x)).Distinct().ToList()
                : elementIds.Distinct().ToList();

            var tagTypeId = ResolveDuctTagTypeId(doc, tagTypeNameContains);
            var planned = new List<object>();
            var created = new List<object>();
            var failures = new List<object>();

            foreach (var id in toTag)
            {
                var e = doc.GetElement(ElementIdCompat.Create(id));
                if (e == null) continue;

                var origin = ResolveElementPoint(e);
                if (origin == null)
                {
                    failures.Add(new { elementId = id, error = "Unable to resolve element point." });
                    continue;
                }

                var point = new XYZ(origin.X + offsetFeet, origin.Y + offsetFeet, origin.Z);
                planned.Add(new
                {
                    elementId = id,
                    point = new[] { point.X, point.Y, point.Z },
                    tagTypeId = tagTypeId == ElementId.InvalidElementId ? (long?)null : ElementIdCompat.GetValue(tagTypeId)
                });
                if (dryRun) continue;

                try
                {
                    var tag = IndependentTag.Create(doc, view.Id, new Reference(e), addTagLeader, TagMode.TM_ADDBY_CATEGORY, TagOrientation.Horizontal, point);
                    if (tag != null && tagTypeId != ElementId.InvalidElementId)
                    {
                        try { tag.ChangeTypeId(tagTypeId); } catch { }
                    }

                    created.Add(new
                    {
                        elementId = id,
                        tagId = tag == null ? (long?)null : ElementIdCompat.GetValue(tag.Id)
                    });
                }
                catch (Exception ex)
                {
                    failures.Add(new { elementId = id, error = ex.Message });
                }
            }

            return new
            {
                viewId = ElementIdCompat.GetValue(view.Id),
                candidates = elementIds.Count,
                toTag = toTag.Count,
                tagged = dryRun ? planned.Count : created.Count,
                failed = failures.Count,
                planned,
                created,
                failures
            };
        }

        private static HashSet<long> GetTaggedElementIdsInView(Document doc, View view)
        {
            var ids = new HashSet<long>();
            foreach (var e in new FilteredElementCollector(doc, view.Id)
                .OfClass(typeof(IndependentTag)))
            {
                if (e is not IndependentTag tag) continue;
                try
                {
                    var tagType = tag.GetType();
                    var method = tagType.GetMethod("GetTaggedLocalElementIds");
                    if (method != null)
                    {
                        var result = method.Invoke(tag, null);
                        if (result is System.Collections.IEnumerable en)
                        {
                            foreach (var item in en)
                            {
                                if (item is ElementId eid)
                                {
                                    var v = ElementIdCompat.GetValue(eid);
                                    if (v > 0) ids.Add(v);
                                }
                            }
                            continue;
                        }
                    }

                    var prop = tagType.GetProperty("TaggedLocalElementId");
                    if (prop != null)
                    {
                        var value = prop.GetValue(tag);
                        if (value is ElementId id)
                        {
                            var v = ElementIdCompat.GetValue(id);
                            if (v > 0) ids.Add(v);
                        }
                    }
                }
                catch
                {
                    // ignored
                }
            }
            return ids;
        }

        private static ElementId ResolveDuctTagTypeId(Document doc, string? nameContains)
        {
            var filter = (nameContains ?? "").Trim();
            var symbols = new FilteredElementCollector(doc)
                .OfClass(typeof(FamilySymbol))
                .OfCategory(BuiltInCategory.OST_DuctTags)
                .Cast<FamilySymbol>()
                .ToList();

            if (symbols.Count == 0) return ElementId.InvalidElementId;
            if (filter.Length == 0) return symbols.First().Id;

            var exact = symbols.FirstOrDefault(s => string.Equals((s.Name ?? "").Trim(), filter, StringComparison.OrdinalIgnoreCase));
            if (exact != null) return exact.Id;

            var contains = symbols.FirstOrDefault(s =>
                (s.Name ?? "").IndexOf(filter, StringComparison.OrdinalIgnoreCase) >= 0 ||
                (s.FamilyName ?? "").IndexOf(filter, StringComparison.OrdinalIgnoreCase) >= 0);
            return contains?.Id ?? symbols.First().Id;
        }

        private static XYZ? ResolveElementPoint(Element e)
        {
            if (e?.Location is LocationPoint lp) return lp.Point;
            if (e?.Location is LocationCurve lc && lc.Curve != null)
            {
                try { return lc.Curve.Evaluate(0.5, true); } catch { return null; }
            }
            return null;
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

        private static string NormalizeAction(string? action)
        {
            var a = (action ?? "audit_duct_slope").Trim().ToLowerInvariant();
            if (a == "set_params" || a == "set_duct_parameters") return "set_duct_parameter_set";
            if (a == "check_duct_slope" || a == "duct_slope") return "audit_duct_slope";
            if (a == "duct_fitting_schedule" || a == "create_fitting_schedule") return "create_duct_fitting_schedule";
            if (a == "mechanical_plan" || a == "create_plan") return "create_mechanical_plan";
            if (a == "coordination_3d" || a == "create_coordination_view") return "create_coordination_3d_view";
            if (a == "sections_along_ducts" || a == "create_sections") return "create_sections_along_ducts";
            if (a == "place_along_ducts" || a == "place_hangers_along_ducts") return "place_family_along_ducts";
            if (a == "connect_duct" || a == "connect_elements") return "connect_elements_with_duct";
            if (a == "connect_with_elbow" || a == "add_elbow") return "connect_elements_with_elbow";
            if (a == "connect_with_transition" || a == "add_transition") return "connect_elements_with_transition";
            if (a == "connect_with_flex" || a == "add_flex") return "connect_elements_with_flex";
            if (a == "route_duct_system" || a == "route_to_terminals") return "route_terminals_to_equipment";
            if (a == "place_equipment_route" || a == "place_ahu_and_route") return "place_equipment_and_connect";
            if (a == "riser_offset" || a == "create_offset") return "create_riser_offset";
            if (a == "ensure_spaces" || a == "spaces_and_tags") return "ensure_spaces_and_tag";
            if (a == "hvac_schematic" || a == "create_schematic") return "create_hvac_schematic";
            if (a == "duplicate_3d_section_box" || a == "duplicate_3d_with_section") return "duplicate_3d_with_section_box";
            if (a == "dependent_with_crop" || a == "create_dependent_crop") return "create_dependent_with_crop";
            return a;
        }

        private static int ClampInt(int value, int min, int max)
        {
            if (value < min) return min;
            if (value > max) return max;
            return value;
        }

        private static long TryReadLong(object payload, string dottedPath)
        {
            try
            {
                using var doc = JsonDocument.Parse(JsonSerializer.Serialize(payload));
                var node = doc.RootElement;
                foreach (var seg in (dottedPath ?? "").Split(new[] { '.' }, StringSplitOptions.RemoveEmptyEntries))
                {
                    if (!node.TryGetProperty(seg, out node)) return 0;
                }
                if (node.ValueKind == JsonValueKind.Number && node.TryGetInt64(out var v)) return v;
            }
            catch
            {
                // ignored
            }
            return 0;
        }
    }
}
