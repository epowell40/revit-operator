using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Reflection;
using System.Text.Json;
using System.Threading.Tasks;
using Autodesk.Revit.DB;
using Autodesk.Revit.UI;
using RevitBridge.Common;
namespace RevitBridge.Logic.Handlers
{
        public sealed class ViewVisibilityHandler : IRequestHandler
        {
        public sealed class Point3
        {
            public double x { get; set; }
            public double y { get; set; }
            public double z { get; set; }
        }

        public sealed class Params
        {
            public long? viewId { get; set; }
            public string? action { get; set; } // get | set_template | hide_category | show_category | set_scale | set_detail_level | set_discipline | set_phase | set_phase_filter | set_section_box | clear_section_box | set_crop_box | clear_crop_box | set_underlay | clear_underlay | set_category_override | clear_category_override | apply_view_filter | create_view_filter | remove_view_filter | clear_filter_override | isolate_elements_temp | isolate_categories_temp | clear_temp_hide_isolate | reveal_hidden_on | reveal_hidden_off | hide_elements | unhide_elements
            public string? categoryName { get; set; }
            public string[]? categoryNames { get; set; }
            public string? templateName { get; set; }
            public long? filterId { get; set; }
            public string? filterName { get; set; }
            public bool? filterVisible { get; set; }
            public int? scale { get; set; }
            public int? lineWeight { get; set; } // projection line weight
            public int? r { get; set; } // projection line color red [0..255]
            public int? g { get; set; } // projection line color green [0..255]
            public int? b { get; set; } // projection line color blue [0..255]
            public string? ruleParameterName { get; set; } // for create_view_filter
            public string? ruleOperator { get; set; } // equals|not_equals|contains|not_contains|begins_with|ends_with|greater|greater_or_equal|less|less_or_equal
            public string? ruleValue { get; set; } // for create_view_filter
            public bool? ruleCaseSensitive { get; set; } // string rule matching mode
            public string? detailLevel { get; set; } // Coarse|Medium|Fine
            public string? discipline { get; set; } // Architectural|Structural|Mechanical|Electrical|Plumbing|Coordination
            public long? phaseId { get; set; }
            public string? phaseName { get; set; }
            public long? phaseFilterId { get; set; }
            public string? phaseFilterName { get; set; }
            public long[]? elementIds { get; set; }
            public long? underlayLevelId { get; set; }
            public string? underlayLevelName { get; set; }
            public long? underlayTopLevelId { get; set; }
            public string? underlayTopLevelName { get; set; }
            public string? underlayOrientation { get; set; } // look_down|look_up
            public Point3? boxMin { get; set; }
            public Point3? boxMax { get; set; }
            public double? annotationCropMarginFeet { get; set; }
            public bool? annotationCropActive { get; set; }
            public bool? includeLinkedModels { get; set; }
            public long? linkedModelInstanceId { get; set; }
            public long? linkedModelId { get; set; }
            public long? revitLinkInstanceId { get; set; }
            public string? linkedModelName { get; set; }
            public string? revitLinkName { get; set; }
            public string? linkName { get; set; }
            public bool? dryRun { get; set; }
        }

        public Task<object> Handle(UIApplication app, string jsonData)
        {
            var p = string.IsNullOrWhiteSpace(jsonData)
                ? new Params()
                : (JsonSerializer.Deserialize<Params>(jsonData) ?? new Params());

            var doc = app.ActiveUIDocument?.Document;
            if (doc == null) throw new InvalidOperationException("No active Revit document.");

            var view = ResolveView(doc, p.viewId);
            if (view == null) throw new InvalidOperationException("View not found. Provide viewId or activate a view.");

            var action = (p.action ?? "get").Trim().ToLowerInvariant();
            if (action == "get")
            {
                return Task.FromResult<object>(BuildViewState(doc, view, "Ok", "get", dryRun: false, p));
            }

            if (IsLinkedCategoryOverrideRequest(action, p))
            {
                return Task.FromResult<object>(BuildUnsupportedLinkedCategoryOverrideState(doc, view, action, p));
            }

            var dryRun = p.dryRun ?? false;
            if (dryRun)
            {
                return Task.FromResult<object>(new
                {
                    status = "Dry Run",
                    action,
                    dryRun = true,
                    input = new
                    {
                        viewId = p.viewId ?? RevitBridge.Common.ElementIdCompat.GetValue(view.Id),
                        p.categoryName,
                        p.templateName,
                        p.filterId,
                        p.filterName,
                        p.filterVisible,
                        p.scale,
                        p.lineWeight,
                        p.r,
                        p.g,
                        p.b,
                        p.ruleParameterName,
                        p.ruleOperator,
                        p.ruleValue,
                        p.ruleCaseSensitive,
                        p.detailLevel,
                        p.discipline,
                        p.phaseId,
                        p.phaseName,
                        p.phaseFilterId,
                        p.phaseFilterName,
                        p.elementIds,
                        p.underlayLevelId,
                        p.underlayLevelName,
                        p.underlayTopLevelId,
                        p.underlayTopLevelName,
                        p.underlayOrientation,
                        p.categoryNames,
                        boxMin = p.boxMin == null ? null : new { p.boxMin.x, p.boxMin.y, p.boxMin.z },
                        boxMax = p.boxMax == null ? null : new { p.boxMax.x, p.boxMax.y, p.boxMax.z }
                    },
                    current = BuildViewState(doc, view, "Ok", "get", dryRun: false, p)
                });
            }

            using (var tx = new Transaction(doc, "Set View Visibility"))
            {
                tx.Start();
                ApplyAction(doc, view, action, p);
                tx.Commit();
            }

            return Task.FromResult<object>(BuildViewState(doc, view, "Success", action, dryRun: false, p));
        }

        private static void ApplyAction(Document doc, View view, string action, Params p)
        {
            switch (action)
            {
                case "set_template":
                {
                    var templateName = (p.templateName ?? "").Trim();
                    if (templateName.Length == 0)
                    {
                        view.ViewTemplateId = ElementId.InvalidElementId;
                        return;
                    }

                    var template = new FilteredElementCollector(doc)
                        .OfClass(typeof(View))
                        .Cast<View>()
                        .FirstOrDefault(v => v.IsTemplate && (v.Name ?? "").Trim().Equals(templateName, StringComparison.OrdinalIgnoreCase));

                    if (template == null) throw new InvalidOperationException($"View Template '{templateName}' not found.");
                    view.ViewTemplateId = template.Id;
                    return;
                }
                case "hide_category":
                case "show_category":
                {
                    var category = ResolveCategory(doc, p.categoryName);
                    if (category == null) throw new InvalidOperationException($"Category '{p.categoryName}' not found.");
                    view.SetCategoryHidden(category.Id, action == "hide_category");
                    return;
                }
                case "set_scale":
                {
                    if (!p.scale.HasValue || p.scale.Value < 1 || p.scale.Value > 1000)
                        throw new InvalidOperationException("visibility.set_scale requires scale in range [1,1000].");
                    view.Scale = p.scale.Value;
                    return;
                }
                case "set_detail_level":
                {
                    var raw = (p.detailLevel ?? "").Trim();
                    if (raw.Length == 0) throw new InvalidOperationException("visibility.set_detail_level requires detailLevel.");
                    if (!TrySetEnumProperty(view, "DetailLevel", raw))
                        throw new InvalidOperationException($"Unable to set detail level '{raw}' on this view.");
                    return;
                }
                case "set_discipline":
                {
                    var raw = (p.discipline ?? "").Trim();
                    if (raw.Length == 0) throw new InvalidOperationException("visibility.set_discipline requires discipline.");
                    if (!TrySetEnumProperty(view, "Discipline", raw))
                        throw new InvalidOperationException($"Unable to set discipline '{raw}' on this view.");
                    return;
                }
                case "set_phase":
                {
                    var phase = ResolvePhase(doc, p.phaseId, p.phaseName);
                    if (phase == null) throw new InvalidOperationException("visibility.set_phase requires phaseId or phaseName.");
                    var set = TrySetBuiltInElementIdParameter(view, "VIEW_PHASE", phase.Id);
                    if (!set) throw new InvalidOperationException("Unable to set view phase for this view.");
                    return;
                }
                case "set_phase_filter":
                {
                    var phaseFilter = ResolvePhaseFilter(doc, p.phaseFilterId, p.phaseFilterName);
                    if (phaseFilter == null) throw new InvalidOperationException("visibility.set_phase_filter requires phaseFilterId or phaseFilterName.");
                    var set = TrySetBuiltInElementIdParameter(view, "VIEW_PHASE_FILTER", phaseFilter.Id);
                    if (!set) throw new InvalidOperationException("Unable to set view phase filter for this view.");
                    return;
                }
                case "set_section_box":
                {
                    if (view is not View3D v3d)
                        throw new InvalidOperationException("visibility.set_section_box requires a 3D view.");
                    if (p.boxMin == null || p.boxMax == null)
                        throw new InvalidOperationException("visibility.set_section_box requires boxMin and boxMax.");

                    var minX = Math.Min(p.boxMin.x, p.boxMax.x);
                    var minY = Math.Min(p.boxMin.y, p.boxMax.y);
                    var minZ = Math.Min(p.boxMin.z, p.boxMax.z);
                    var maxX = Math.Max(p.boxMin.x, p.boxMax.x);
                    var maxY = Math.Max(p.boxMin.y, p.boxMax.y);
                    var maxZ = Math.Max(p.boxMin.z, p.boxMax.z);

                    var box = v3d.GetSectionBox() ?? new BoundingBoxXYZ();
                    box.Min = new XYZ(minX, minY, minZ);
                    box.Max = new XYZ(maxX, maxY, maxZ);
                    v3d.SetSectionBox(box);
                    v3d.IsSectionBoxActive = true;
                    return;
                }
                case "clear_section_box":
                {
                    if (view is not View3D v3d)
                        throw new InvalidOperationException("visibility.clear_section_box requires a 3D view.");
                    v3d.IsSectionBoxActive = false;
                    return;
                }
                case "set_crop_box":
                {
                    if (p.boxMin == null || p.boxMax == null)
                        throw new InvalidOperationException("visibility.set_crop_box requires boxMin and boxMax.");

                    BoundingBoxXYZ current;
                    try
                    {
                        current = view.CropBox;
                    }
                    catch
                    {
                        throw new InvalidOperationException("visibility.set_crop_box is not supported for this view type.");
                    }

                    if (current == null)
                        throw new InvalidOperationException("visibility.set_crop_box is not available for this view.");

                    var minX = Math.Min(p.boxMin.x, p.boxMax.x);
                    var minY = Math.Min(p.boxMin.y, p.boxMax.y);
                    var minZ = Math.Min(p.boxMin.z, p.boxMax.z);
                    var maxX = Math.Max(p.boxMin.x, p.boxMax.x);
                    var maxY = Math.Max(p.boxMin.y, p.boxMax.y);
                    var maxZ = Math.Max(p.boxMin.z, p.boxMax.z);

                    var newCrop = new BoundingBoxXYZ
                    {
                        Transform = current.Transform,
                        Min = new XYZ(minX, minY, minZ),
                        Max = new XYZ(maxX, maxY, maxZ)
                    };

                    view.CropBox = newCrop;
                    try { view.CropBoxActive = true; } catch { }
                    if (p.annotationCropMarginFeet.HasValue || p.annotationCropActive.HasValue)
                    {
                        var margin = Math.Max(0, p.annotationCropMarginFeet ?? 0.15);
                        TrySetAnnotationCrop(view, margin, p.annotationCropActive ?? true);
                    }
                    return;
                }
                case "clear_crop_box":
                {
                    try
                    {
                        view.CropBoxActive = false;
                    }
                    catch
                    {
                        throw new InvalidOperationException("visibility.clear_crop_box is not supported for this view type.");
                    }
                    return;
                }
                case "set_category_override":
                {
                    var category = ResolveCategory(doc, p.categoryName);
                    if (category == null) throw new InvalidOperationException($"Category '{p.categoryName}' not found.");

                    var ogs = view.GetCategoryOverrides(category.Id);
                    var changed = false;

                    if (p.lineWeight.HasValue)
                    {
                        if (p.lineWeight.Value < 1 || p.lineWeight.Value > 16)
                            throw new InvalidOperationException("visibility.lineWeight must be in range [1,16].");
                        ogs.SetProjectionLineWeight(p.lineWeight.Value);
                        changed = true;
                    }

                    if (p.r.HasValue || p.g.HasValue || p.b.HasValue)
                    {
                        if (!(p.r.HasValue && p.g.HasValue && p.b.HasValue))
                            throw new InvalidOperationException("visibility.set_category_override requires r, g, b together.");
                        if (!IsByteRange(p.r.Value) || !IsByteRange(p.g.Value) || !IsByteRange(p.b.Value))
                            throw new InvalidOperationException("visibility color channels r,g,b must be in range [0,255].");

                        var color = new Color((byte)p.r.Value, (byte)p.g.Value, (byte)p.b.Value);
                        ogs.SetProjectionLineColor(color);
                        changed = true;
                    }

                    if (!changed)
                        throw new InvalidOperationException("visibility.set_category_override requires lineWeight and/or r,g,b.");

                    view.SetCategoryOverrides(category.Id, ogs);
                    return;
                }
                case "clear_category_override":
                {
                    var category = ResolveCategory(doc, p.categoryName);
                    if (category == null) throw new InvalidOperationException($"Category '{p.categoryName}' not found.");
                    view.SetCategoryOverrides(category.Id, new OverrideGraphicSettings());
                    return;
                }
                case "apply_view_filter":
                {
                    var filter = ResolveViewFilter(doc, p.filterId, p.filterName);
                    if (filter == null) throw new InvalidOperationException("visibility.apply_view_filter requires filterId or filterName.");

                    if (!ViewHasFilter(view, filter.Id))
                    {
                        view.AddFilter(filter.Id);
                    }

                    if (p.filterVisible.HasValue)
                    {
                        view.SetFilterVisibility(filter.Id, p.filterVisible.Value);
                    }

                    var changed = false;
                    var ogs = view.GetFilterOverrides(filter.Id);
                    if (p.lineWeight.HasValue)
                    {
                        if (p.lineWeight.Value < 1 || p.lineWeight.Value > 16)
                            throw new InvalidOperationException("visibility.lineWeight must be in range [1,16].");
                        ogs.SetProjectionLineWeight(p.lineWeight.Value);
                        changed = true;
                    }
                    if (p.r.HasValue || p.g.HasValue || p.b.HasValue)
                    {
                        if (!(p.r.HasValue && p.g.HasValue && p.b.HasValue))
                            throw new InvalidOperationException("visibility.apply_view_filter requires r, g, b together.");
                        if (!IsByteRange(p.r.Value) || !IsByteRange(p.g.Value) || !IsByteRange(p.b.Value))
                            throw new InvalidOperationException("visibility color channels r,g,b must be in range [0,255].");
                        ogs.SetProjectionLineColor(new Color((byte)p.r.Value, (byte)p.g.Value, (byte)p.b.Value));
                        changed = true;
                    }
                    if (changed)
                    {
                        view.SetFilterOverrides(filter.Id, ogs);
                    }
                    return;
                }
                case "create_view_filter":
                {
                    var created = CreateOrUpdateViewFilter(doc, view, p);
                    if (p.filterVisible.HasValue)
                    {
                        view.SetFilterVisibility(created.Id, p.filterVisible.Value);
                    }

                    var changed = false;
                    var ogs = view.GetFilterOverrides(created.Id);
                    if (p.lineWeight.HasValue)
                    {
                        if (p.lineWeight.Value < 1 || p.lineWeight.Value > 16)
                            throw new InvalidOperationException("visibility.lineWeight must be in range [1,16].");
                        ogs.SetProjectionLineWeight(p.lineWeight.Value);
                        changed = true;
                    }
                    if (p.r.HasValue || p.g.HasValue || p.b.HasValue)
                    {
                        if (!(p.r.HasValue && p.g.HasValue && p.b.HasValue))
                            throw new InvalidOperationException("visibility.create_view_filter requires r, g, b together.");
                        if (!IsByteRange(p.r.Value) || !IsByteRange(p.g.Value) || !IsByteRange(p.b.Value))
                            throw new InvalidOperationException("visibility color channels r,g,b must be in range [0,255].");
                        ogs.SetProjectionLineColor(new Color((byte)p.r.Value, (byte)p.g.Value, (byte)p.b.Value));
                        changed = true;
                    }
                    if (changed)
                    {
                        view.SetFilterOverrides(created.Id, ogs);
                    }
                    return;
                }
                case "remove_view_filter":
                {
                    var filter = ResolveViewFilter(doc, p.filterId, p.filterName);
                    if (filter == null) throw new InvalidOperationException("visibility.remove_view_filter requires filterId or filterName.");
                    if (ViewHasFilter(view, filter.Id))
                    {
                        view.RemoveFilter(filter.Id);
                    }
                    return;
                }
                case "clear_filter_override":
                {
                    var filter = ResolveViewFilter(doc, p.filterId, p.filterName);
                    if (filter == null) throw new InvalidOperationException("visibility.clear_filter_override requires filterId or filterName.");
                    if (!ViewHasFilter(view, filter.Id))
                        throw new InvalidOperationException($"Filter '{filter.Name}' is not applied to this view.");
                    view.SetFilterOverrides(filter.Id, new OverrideGraphicSettings());
                    return;
                }
                case "set_underlay":
                {
                    if (view is not ViewPlan)
                        throw new InvalidOperationException("visibility.set_underlay requires a plan view.");

                    var bottomLevel = ResolveLevel(doc, p.underlayLevelId, p.underlayLevelName);
                    if (bottomLevel == null)
                        throw new InvalidOperationException("visibility.set_underlay requires underlayLevelId or underlayLevelName.");

                    var setLevel = TrySetBuiltInElementIdParameter(view, "VIEW_UNDERLAY_ID", bottomLevel.Id)
                        || TrySetBuiltInElementIdParameter(view, "VIEW_UNDERLAY_BOTTOM_ID", bottomLevel.Id);
                    if (!setLevel)
                        throw new InvalidOperationException("Unable to set underlay level on this view.");

                    var topLevel = ResolveLevel(doc, p.underlayTopLevelId, p.underlayTopLevelName);
                    if (topLevel != null)
                    {
                        var setTop = TrySetBuiltInElementIdParameter(view, "VIEW_UNDERLAY_TOP_ID", topLevel.Id);
                        if (!setTop)
                            throw new InvalidOperationException("Unable to set underlay top level on this view.");
                    }

                    var orientation = (p.underlayOrientation ?? "").Trim();
                    if (orientation.Length > 0)
                    {
                        var orientationSet =
                            TrySetUnderlayOrientationByProperty(view, orientation) ||
                            TrySetUnderlayOrientationByParameter(view, orientation);
                        if (!orientationSet)
                            throw new InvalidOperationException($"Unable to set underlay orientation '{orientation}'.");
                    }
                    return;
                }
                case "clear_underlay":
                {
                    if (view is not ViewPlan)
                        throw new InvalidOperationException("visibility.clear_underlay requires a plan view.");

                    var cleared = false;
                    cleared |= TrySetBuiltInElementIdParameter(view, "VIEW_UNDERLAY_ID", ElementId.InvalidElementId);
                    cleared |= TrySetBuiltInElementIdParameter(view, "VIEW_UNDERLAY_BOTTOM_ID", ElementId.InvalidElementId);
                    cleared |= TrySetBuiltInElementIdParameter(view, "VIEW_UNDERLAY_TOP_ID", ElementId.InvalidElementId);
                    if (!cleared)
                        throw new InvalidOperationException("Unable to clear underlay on this view.");
                    return;
                }
                case "isolate_elements_temp":
                {
                    var ids = ResolveElementIds(doc, p.elementIds);
                    if (ids.Count == 0) throw new InvalidOperationException("visibility.isolate_elements_temp requires elementIds.");
                    view.IsolateElementsTemporary(ids);
                    return;
                }
                case "isolate_categories_temp":
                {
                    var catIds = ResolveCategoryIds(doc, p.categoryName, p.categoryNames);
                    if (catIds.Count == 0) throw new InvalidOperationException("visibility.isolate_categories_temp requires categoryName or categoryNames.");
                    view.IsolateCategoriesTemporary(catIds);
                    return;
                }
                case "clear_temp_hide_isolate":
                {
                    view.DisableTemporaryViewMode(TemporaryViewMode.TemporaryHideIsolate);
                    return;
                }
                case "reveal_hidden_on":
                {
                    view.EnableRevealHiddenMode();
                    return;
                }
                case "reveal_hidden_off":
                {
                    view.DisableTemporaryViewMode(TemporaryViewMode.RevealHiddenElements);
                    return;
                }
                case "hide_elements":
                {
                    var ids = ResolveElementIds(doc, p.elementIds);
                    if (ids.Count == 0) throw new InvalidOperationException("visibility.hide_elements requires elementIds.");
                    view.HideElements(ids);
                    return;
                }
                case "unhide_elements":
                {
                    var ids = ResolveElementIds(doc, p.elementIds);
                    if (ids.Count == 0) throw new InvalidOperationException("visibility.unhide_elements requires elementIds.");
                    view.UnhideElements(ids);
                    return;
                }
                default:
                    throw new InvalidOperationException("visibility.action must be one of: get, set_template, hide_category, show_category, set_scale, set_detail_level, set_discipline, set_phase, set_phase_filter, set_section_box, clear_section_box, set_crop_box, clear_crop_box, set_underlay, clear_underlay, set_category_override, clear_category_override, apply_view_filter, create_view_filter, remove_view_filter, clear_filter_override, isolate_elements_temp, isolate_categories_temp, clear_temp_hide_isolate, reveal_hidden_on, reveal_hidden_off, hide_elements, unhide_elements.");
            }
        }

        private static bool IsByteRange(int value) => value >= 0 && value <= 255;

        private static ParameterFilterElement? ResolveViewFilter(Document doc, long? filterId, string? filterName)
        {
            if (filterId.HasValue && filterId.Value > 0)
            {
                return doc.GetElement(RevitBridge.Common.ElementIdCompat.Create(filterId.Value)) as ParameterFilterElement;
            }

            var name = (filterName ?? "").Trim();
            if (name.Length == 0) return null;

            return new FilteredElementCollector(doc)
                .OfClass(typeof(ParameterFilterElement))
                .Cast<ParameterFilterElement>()
                .FirstOrDefault(f => (f.Name ?? "").Trim().Equals(name, StringComparison.OrdinalIgnoreCase));
        }

        private static ParameterFilterElement CreateOrUpdateViewFilter(Document doc, View view, Params p)
        {
            var filterName = (p.filterName ?? "").Trim();
            if (filterName.Length == 0)
            {
                throw new InvalidOperationException("visibility.create_view_filter requires filterName.");
            }

            var categoryIds = ResolveCategoryIds(doc, p.categoryName, p.categoryNames);
            if (categoryIds.Count == 0)
            {
                throw new InvalidOperationException("visibility.create_view_filter requires categoryName or categoryNames.");
            }

            var ruleParamName = (p.ruleParameterName ?? "").Trim();
            if (ruleParamName.Length == 0)
            {
                throw new InvalidOperationException("visibility.create_view_filter requires ruleParameterName.");
            }

            var existing = ResolveViewFilter(doc, null, filterName);
            var filter = existing ?? ParameterFilterElement.Create(doc, filterName, categoryIds);
            if (existing != null)
            {
                filter.SetCategories(categoryIds);
            }

            var resolvedRuleParameter = ResolveRuleParameter(doc, categoryIds, ruleParamName);
            if (resolvedRuleParameter == null)
            {
                throw new InvalidOperationException($"visibility.create_view_filter could not resolve parameter '{ruleParamName}' in selected categories.");
            }

            var rule = BuildFilterRule(
                resolvedRuleParameter.ParameterId,
                resolvedRuleParameter.StorageType,
                p.ruleOperator,
                p.ruleValue,
                p.ruleCaseSensitive ?? false);
            var elementFilter = new ElementParameterFilter(rule);
            filter.SetElementFilter(elementFilter);

            if (!ViewHasFilter(view, filter.Id))
            {
                view.AddFilter(filter.Id);
            }

            return filter;
        }

        private sealed class ResolvedRuleParameter
        {
            public ElementId ParameterId { get; set; } = ElementId.InvalidElementId;
            public StorageType StorageType { get; set; } = StorageType.String;
        }

        private static ResolvedRuleParameter? ResolveRuleParameter(Document doc, List<ElementId> categoryIds, string parameterNameOrBuiltIn)
        {
            var token = (parameterNameOrBuiltIn ?? "").Trim();
            if (token.Length == 0) return null;

            BuiltInParameter? builtIn = null;
            if (Enum.TryParse(token, ignoreCase: true, out BuiltInParameter parsedBip))
            {
                builtIn = parsedBip;
            }

            foreach (var catId in categoryIds)
            {
                var sample = new FilteredElementCollector(doc)
                    .OfCategoryId(catId)
                    .WhereElementIsNotElementType()
                    .Take(250);

                foreach (var element in sample)
                {
                    var parameter = ResolveParameterFromElement(element, token, builtIn);
                    if (parameter == null) continue;

                    return new ResolvedRuleParameter
                    {
                        ParameterId = parameter.Id,
                        StorageType = parameter.StorageType
                    };
                }
            }

            if (builtIn.HasValue)
            {
                return new ResolvedRuleParameter
                {
                    ParameterId = RevitBridge.Common.ElementIdCompat.Create((long)builtIn.Value),
                    StorageType = StorageType.String
                };
            }

            return null;
        }

        private static Parameter? ResolveParameterFromElement(Element element, string parameterName, BuiltInParameter? builtIn)
        {
            if (builtIn.HasValue)
            {
                try
                {
                    var bipParam = element.get_Parameter(builtIn.Value);
                    if (bipParam != null) return bipParam;
                }
                catch
                {
                    // ignore
                }
            }

            try
            {
                var byLookup = element.LookupParameter(parameterName);
                if (byLookup != null) return byLookup;
            }
            catch
            {
                // ignore
            }

            try
            {
                return element.Parameters
                    .Cast<Parameter>()
                    .FirstOrDefault(x =>
                        x.Definition != null &&
                        (x.Definition.Name ?? "").Trim().Equals(parameterName, StringComparison.OrdinalIgnoreCase));
            }
            catch
            {
                return null;
            }
        }

        private static FilterRule BuildFilterRule(ElementId parameterId, StorageType storageType, string? ruleOperatorRaw, string? ruleValueRaw, bool caseSensitive)
        {
            var op = NormalizeRuleOperator(ruleOperatorRaw);
            var value = (ruleValueRaw ?? "").Trim();

            switch (storageType)
            {
                case StorageType.Integer:
                {
                    if (!int.TryParse(value, NumberStyles.Integer, CultureInfo.InvariantCulture, out var iv))
                        throw new InvalidOperationException("visibility.create_view_filter expected integer ruleValue for the selected parameter.");
                    return op switch
                    {
                        "equals" => ParameterFilterRuleFactory.CreateEqualsRule(parameterId, iv),
                        "not_equals" => ParameterFilterRuleFactory.CreateNotEqualsRule(parameterId, iv),
                        "greater" => ParameterFilterRuleFactory.CreateGreaterRule(parameterId, iv),
                        "greater_or_equal" => ParameterFilterRuleFactory.CreateGreaterOrEqualRule(parameterId, iv),
                        "less" => ParameterFilterRuleFactory.CreateLessRule(parameterId, iv),
                        "less_or_equal" => ParameterFilterRuleFactory.CreateLessOrEqualRule(parameterId, iv),
                        _ => throw new InvalidOperationException($"visibility.create_view_filter does not support operator '{op}' for integer parameters.")
                    };
                }
                case StorageType.ElementId:
                {
                    if (!long.TryParse(value, NumberStyles.Integer, CultureInfo.InvariantCulture, out var elementIdValue) || elementIdValue <= 0)
                        throw new InvalidOperationException("visibility.create_view_filter expected positive integer ruleValue for an ElementId parameter.");
                    var elementId = RevitBridge.Common.ElementIdCompat.Create(elementIdValue);
                    return op switch
                    {
                        "equals" => ParameterFilterRuleFactory.CreateEqualsRule(parameterId, elementId),
                        "not_equals" => ParameterFilterRuleFactory.CreateNotEqualsRule(parameterId, elementId),
                        _ => throw new InvalidOperationException($"visibility.create_view_filter does not support operator '{op}' for ElementId parameters.")
                    };
                }
                default:
                {
                    if (value.Length == 0)
                        throw new InvalidOperationException("visibility.create_view_filter requires ruleValue for string rules.");
                    return op switch
                    {
                        "equals" => ParameterFilterRuleFactory.CreateEqualsRule(parameterId, value),
                        "not_equals" => ParameterFilterRuleFactory.CreateNotEqualsRule(parameterId, value),
                        "contains" => ParameterFilterRuleFactory.CreateContainsRule(parameterId, value),
                        "not_contains" => ParameterFilterRuleFactory.CreateNotContainsRule(parameterId, value),
                        "begins_with" => ParameterFilterRuleFactory.CreateBeginsWithRule(parameterId, value),
                        "ends_with" => ParameterFilterRuleFactory.CreateEndsWithRule(parameterId, value),
                        _ => throw new InvalidOperationException($"visibility.create_view_filter does not support operator '{op}' for string parameters.")
                    };
                }
            }
        }

        private static string NormalizeRuleOperator(string? raw)
        {
            var op = (raw ?? "contains").Trim().ToLowerInvariant().Replace("-", "_").Replace(" ", "_");
            return op.Length == 0 ? "contains" : op;
        }

        private static bool ViewHasFilter(View view, ElementId filterId)
        {
            try
            {
                return view.GetFilters().Any(x => x == filterId);
            }
            catch
            {
                return false;
            }
        }

        private static View? ResolveView(Document doc, long? viewId)
        {
            if (viewId.HasValue && viewId.Value > 0)
            {
                return doc.GetElement(RevitBridge.Common.ElementIdCompat.Create(viewId.Value)) as View;
            }
            return doc.ActiveView;
        }

        private static Category? ResolveCategory(Document doc, string? categoryName)
        {
            var input = (categoryName ?? "").Trim();
            if (input.Length == 0) return null;

            if (Enum.TryParse(input, ignoreCase: true, out BuiltInCategory bic))
            {
                try { return doc.Settings.Categories.get_Item(bic); } catch { }
            }

            try
            {
                return EnumerateCategories(doc.Settings.Categories)
                    .FirstOrDefault(c => (c?.Name ?? "").Equals(input, StringComparison.OrdinalIgnoreCase));
            }
            catch
            {
                return null;
            }
        }

        private static IEnumerable<Category> EnumerateCategories(Categories categories)
        {
            foreach (Category category in categories)
            {
                if (category == null) continue;
                foreach (var entry in EnumerateCategoryTree(category))
                    yield return entry;
            }
        }

        private static IEnumerable<Category> EnumerateCategoryTree(Category category)
        {
            yield return category;
            CategoryNameMap? subCategories = null;
            try { subCategories = category.SubCategories; } catch { }
            if (subCategories == null) yield break;

            foreach (Category sub in subCategories)
            {
                foreach (var nested in EnumerateCategoryTree(sub))
                    yield return nested;
            }
        }

        private static List<ElementId> ResolveCategoryIds(Document doc, string? categoryName, string[]? categoryNames)
        {
            var names = new List<string>();
            if (!string.IsNullOrWhiteSpace(categoryName)) names.Add(categoryName.Trim());
            if (categoryNames != null)
            {
                names.AddRange(categoryNames
                    .Where(x => !string.IsNullOrWhiteSpace(x))
                    .Select(x => x.Trim()));
            }

            return names
                .Distinct(StringComparer.OrdinalIgnoreCase)
                .Select(name => ResolveCategory(doc, name))
                .Where(c => c != null)
                .Select(c => c!.Id)
                .ToList();
        }

        private static List<ElementId> ResolveElementIds(Document doc, long[]? elementIds)
        {
            if (elementIds == null || elementIds.Length == 0) return new List<ElementId>();

            return elementIds
                .Where(x => x > 0)
                .Distinct()
                .Select(id => RevitBridge.Common.ElementIdCompat.Create(id))
                .Where(id => doc.GetElement(id) != null)
                .ToList();
        }

        private static Phase? ResolvePhase(Document doc, long? phaseId, string? phaseName)
        {
            if (phaseId.HasValue && phaseId.Value > 0)
            {
                return doc.Phases
                    .Cast<Phase>()
                    .FirstOrDefault(p => RevitBridge.Common.ElementIdCompat.GetValue(p.Id) == phaseId.Value);
            }

            var name = (phaseName ?? "").Trim();
            if (name.Length == 0) return null;

            return doc.Phases
                .Cast<Phase>()
                .FirstOrDefault(p => (p.Name ?? "").Trim().Equals(name, StringComparison.OrdinalIgnoreCase));
        }

        private static PhaseFilter? ResolvePhaseFilter(Document doc, long? phaseFilterId, string? phaseFilterName)
        {
            if (phaseFilterId.HasValue && phaseFilterId.Value > 0)
            {
                return doc.GetElement(RevitBridge.Common.ElementIdCompat.Create(phaseFilterId.Value)) as PhaseFilter;
            }

            var name = (phaseFilterName ?? "").Trim();
            if (name.Length == 0) return null;

            return new FilteredElementCollector(doc)
                .OfClass(typeof(PhaseFilter))
                .Cast<PhaseFilter>()
                .FirstOrDefault(x => (x.Name ?? "").Trim().Equals(name, StringComparison.OrdinalIgnoreCase));
        }

        private static bool TrySetEnumProperty(object target, string propName, string value)
        {
            try
            {
                var p = target.GetType().GetProperty(propName, BindingFlags.Instance | BindingFlags.Public);
                if (p == null || !p.CanWrite || !p.PropertyType.IsEnum) return false;
                var parsed = Enum.Parse(p.PropertyType, value, ignoreCase: true);
                p.SetValue(target, parsed, null);
                return true;
            }
            catch
            {
                return false;
            }
        }

        private static bool TrySetUnderlayOrientationByProperty(View view, string rawValue)
        {
            var prop = view.GetType().GetProperty("UnderlayOrientation", BindingFlags.Instance | BindingFlags.Public);
            if (prop == null || !prop.CanWrite || !prop.PropertyType.IsEnum) return false;

            var normalized = NormalizeUnderlayOrientation(rawValue);
            if (normalized == null) return false;

            try
            {
                var parsed = Enum.Parse(prop.PropertyType, normalized, ignoreCase: true);
                prop.SetValue(view, parsed, null);
                return true;
            }
            catch
            {
                return false;
            }
        }

        private static bool TrySetUnderlayOrientationByParameter(View view, string rawValue)
        {
            var normalized = NormalizeUnderlayOrientation(rawValue);
            if (normalized == null) return false;

            int? value = normalized switch
            {
                "LookDown" => 0,
                "LookUp" => 1,
                _ => null
            };
            if (!value.HasValue) return false;

            return TrySetBuiltInIntegerParameter(view, "VIEW_UNDERLAY_ORIENTATION", value.Value);
        }

        private static string? NormalizeUnderlayOrientation(string raw)
        {
            var key = (raw ?? "").Trim().ToLowerInvariant();
            return key switch
            {
                "lookdown" => "LookDown",
                "look_down" => "LookDown",
                "down" => "LookDown",
                "lookup" => "LookUp",
                "look_up" => "LookUp",
                "up" => "LookUp",
                _ => null
            };
        }

        private static bool IsLinkedCategoryOverrideRequest(string action, Params p)
        {
            if (action != "set_category_override" && action != "clear_category_override") return false;
            return (p.linkedModelInstanceId.HasValue && p.linkedModelInstanceId.Value > 0) ||
                   (p.linkedModelId.HasValue && p.linkedModelId.Value > 0) ||
                   (p.revitLinkInstanceId.HasValue && p.revitLinkInstanceId.Value > 0) ||
                   !string.IsNullOrWhiteSpace(p.linkedModelName) ||
                   !string.IsNullOrWhiteSpace(p.revitLinkName) ||
                   !string.IsNullOrWhiteSpace(p.linkName);
        }

        private static object BuildUnsupportedLinkedCategoryOverrideState(Document doc, View view, string action, Params p)
        {
            return new
            {
                status = "Blocked",
                action,
                blockCode = "linked_model_category_override_not_supported",
                message = "Revit 2024 exposes linked model visibility/phase inventory and link-level display overrides, but this handler cannot prove a per-linked-category lineweight override. Refusing to apply a host category override for a linked-model request.",
                dryRun = p.dryRun ?? false,
                input = new
                {
                    viewId = p.viewId ?? RevitBridge.Common.ElementIdCompat.GetValue(view.Id),
                    p.linkedModelInstanceId,
                    p.linkedModelId,
                    p.revitLinkInstanceId,
                    p.linkedModelName,
                    p.revitLinkName,
                    p.linkName,
                    p.categoryName,
                    p.lineWeight,
                    p.r,
                    p.g,
                    p.b
                },
                view = BuildViewState(doc, view, "Ok", "get", dryRun: false, new Params { categoryName = p.categoryName, includeLinkedModels = true })
            };
        }

        private static bool TrySetBuiltInElementIdParameter(View view, string builtInParameterName, ElementId value)
        {
            try
            {
                var bip = (BuiltInParameter)Enum.Parse(typeof(BuiltInParameter), builtInParameterName, ignoreCase: true);
                var param = view.get_Parameter(bip);
                if (param == null || param.IsReadOnly || param.StorageType != StorageType.ElementId) return false;
                return param.Set(value);
            }
            catch
            {
                return false;
            }
        }

        private static bool TrySetBuiltInIntegerParameter(View view, string builtInParameterName, int value)
        {
            try
            {
                var bip = (BuiltInParameter)Enum.Parse(typeof(BuiltInParameter), builtInParameterName, ignoreCase: true);
                var param = view.get_Parameter(bip);
                if (param == null || param.IsReadOnly || param.StorageType != StorageType.Integer) return false;
                return param.Set(value);
            }
            catch
            {
                return false;
            }
        }

        private static void TrySetAnnotationCrop(View view, double marginFeet, bool active)
        {
            TrySetBuiltInIntegerParameter(view, "VIEWER_ANNOTATION_CROP_ACTIVE", active ? 1 : 0);

            object? manager = null;
            try
            {
                manager = view.GetType().GetMethod("GetCropRegionShapeManager", Type.EmptyTypes)?.Invoke(view, null);
            }
            catch
            {
                manager = null;
            }

            if (manager == null) return;

            foreach (var propertyName in new[]
            {
                "LeftAnnotationCropOffset",
                "RightAnnotationCropOffset",
                "TopAnnotationCropOffset",
                "BottomAnnotationCropOffset"
            })
            {
                try
                {
                    var property = manager.GetType().GetProperty(propertyName, BindingFlags.Instance | BindingFlags.Public);
                    if (property != null && property.CanWrite)
                    {
                        property.SetValue(manager, marginFeet);
                    }
                }
                catch
                {
                    // Best effort: some view types/templates do not allow every annotation-crop edge.
                }
            }
        }

        private static Level? ResolveLevel(Document doc, long? levelId, string? levelName)
        {
            if (levelId.HasValue && levelId.Value > 0)
            {
                return doc.GetElement(RevitBridge.Common.ElementIdCompat.Create(levelId.Value)) as Level;
            }

            var name = (levelName ?? "").Trim();
            if (name.Length == 0) return null;

            return new FilteredElementCollector(doc)
                .OfClass(typeof(Level))
                .Cast<Level>()
                .FirstOrDefault(l => (l.Name ?? "").Trim().Equals(name, StringComparison.OrdinalIgnoreCase));
        }

        private static Level? TryGetUnderlayLevel(Document doc, View view)
        {
            foreach (var bipName in new[] { "VIEW_UNDERLAY_ID", "VIEW_UNDERLAY_BOTTOM_ID" })
            {
                try
                {
                    var bip = (BuiltInParameter)Enum.Parse(typeof(BuiltInParameter), bipName, ignoreCase: true);
                    var p = view.get_Parameter(bip);
                    if (p == null || p.StorageType != StorageType.ElementId) continue;
                    var id = p.AsElementId();
                    if (id == null || id == ElementId.InvalidElementId) continue;
                    var level = doc.GetElement(id) as Level;
                    if (level != null) return level;
                }
                catch
                {
                    // ignore
                }
            }

            return null;
        }

        private static Level? TryGetUnderlayTopLevel(Document doc, View view)
        {
            try
            {
                var bip = (BuiltInParameter)Enum.Parse(typeof(BuiltInParameter), "VIEW_UNDERLAY_TOP_ID", ignoreCase: true);
                var p = view.get_Parameter(bip);
                if (p == null || p.StorageType != StorageType.ElementId) return null;
                var id = p.AsElementId();
                if (id == null || id == ElementId.InvalidElementId) return null;
                return doc.GetElement(id) as Level;
            }
            catch
            {
                return null;
            }
        }

        private static Phase? TryGetPhase(Document doc, View view)
        {
            try
            {
                var bip = (BuiltInParameter)Enum.Parse(typeof(BuiltInParameter), "VIEW_PHASE", ignoreCase: true);
                var p = view.get_Parameter(bip);
                if (p == null || p.StorageType != StorageType.ElementId) return null;
                var id = p.AsElementId();
                if (id == null || id == ElementId.InvalidElementId) return null;
                return doc.Phases.Cast<Phase>().FirstOrDefault(x => x.Id == id);
            }
            catch
            {
                return null;
            }
        }

        private static PhaseFilter? TryGetPhaseFilter(Document doc, View view)
        {
            try
            {
                var bip = (BuiltInParameter)Enum.Parse(typeof(BuiltInParameter), "VIEW_PHASE_FILTER", ignoreCase: true);
                var p = view.get_Parameter(bip);
                if (p == null || p.StorageType != StorageType.ElementId) return null;
                var id = p.AsElementId();
                if (id == null || id == ElementId.InvalidElementId) return null;
                return doc.GetElement(id) as PhaseFilter;
            }
            catch
            {
                return null;
            }
        }

        private static bool? TryGetTempModeState(View view, TemporaryViewMode mode)
        {
            try
            {
                return view.IsInTemporaryViewMode(mode);
            }
            catch
            {
                return null;
            }
        }

        private static string? TryReadUnderlayOrientation(View view)
        {
            var propVal = TryReadProperty(view, "UnderlayOrientation");
            if (!string.IsNullOrWhiteSpace(propVal)) return propVal;

            try
            {
                var bip = (BuiltInParameter)Enum.Parse(typeof(BuiltInParameter), "VIEW_UNDERLAY_ORIENTATION", ignoreCase: true);
                var p = view.get_Parameter(bip);
                if (p != null && p.StorageType == StorageType.Integer)
                {
                    var v = p.AsInteger();
                    return v switch
                    {
                        0 => "LookDown",
                        1 => "LookUp",
                        _ => v.ToString()
                    };
                }
            }
            catch
            {
                // ignore
            }

            return null;
        }

        private static object BuildViewState(Document doc, View view, string status, string action, bool dryRun, Params? p = null)
        {
            View? viewTemplate = null;
            if (view.ViewTemplateId != ElementId.InvalidElementId)
            {
                viewTemplate = doc.GetElement(view.ViewTemplateId) as View;
            }

            var detailLevel = TryReadProperty(view, "DetailLevel");
            var discipline = TryReadProperty(view, "Discipline");
            object? sectionBox = null;
            if (view is View3D v3d)
            {
                try
                {
                    var box = v3d.GetSectionBox();
                    sectionBox = new
                    {
                        isActive = v3d.IsSectionBoxActive,
                        min = box == null ? null : new { x = box.Min.X, y = box.Min.Y, z = box.Min.Z },
                        max = box == null ? null : new { x = box.Max.X, y = box.Max.Y, z = box.Max.Z }
                    };
                }
                catch
                {
                    sectionBox = new { isActive = false };
                }
            }
            object? cropBox = null;
            try
            {
                var cb = view.CropBox;
                cropBox = new
                {
                    isActive = view.CropBoxActive,
                    isVisible = view.CropBoxVisible,
                    min = cb == null ? null : new { x = cb.Min.X, y = cb.Min.Y, z = cb.Min.Z },
                    max = cb == null ? null : new { x = cb.Max.X, y = cb.Max.Y, z = cb.Max.Z }
                };
            }
            catch
            {
                // Some views do not support crop boxes.
            }
            object? underlay = null;
            if (view is ViewPlan)
            {
                var ulBottom = TryGetUnderlayLevel(doc, view);
                var ulTop = TryGetUnderlayTopLevel(doc, view);
                underlay = new
                {
                    levelId = RevitBridge.Common.ElementIdCompat.GetValue(ulBottom?.Id),
                    levelName = ulBottom?.Name,
                    topLevelId = RevitBridge.Common.ElementIdCompat.GetValue(ulTop?.Id),
                    topLevelName = ulTop?.Name,
                    orientation = TryReadUnderlayOrientation(view)
                };
            }
            var phase = TryGetPhase(doc, view);
            var phaseFilter = TryGetPhaseFilter(doc, view);
            var linkedModels = (p?.includeLinkedModels ?? false) ? BuildLinkedModelsState(doc) : null;
            var temporaryModes = new
            {
                hideIsolate = TryGetTempModeState(view, TemporaryViewMode.TemporaryHideIsolate),
                revealHidden = TryGetTempModeState(view, TemporaryViewMode.RevealHiddenElements)
            };
            object? viewFilters = null;
            try
            {
                viewFilters = view.GetFilters()
                    .Select(id =>
                    {
                        var f = doc.GetElement(id) as ParameterFilterElement;
                        bool? visible = null;
                        try { visible = view.GetFilterVisibility(id); } catch { }
                        return new
                        {
                            id = RevitBridge.Common.ElementIdCompat.GetValue(id),
                            name = f?.Name,
                            visible,
                            @override = BuildFilterOverrideState(doc, view, id)
                        };
                    })
                    .ToArray();
            }
            catch
            {
                // Some view types do not support filters.
            }
            var categoryOverride = BuildCategoryOverrideState(doc, view, p?.categoryName);

            return new
            {
                status,
                action,
                dryRun,
                view = new
                {
                    id = RevitBridge.Common.ElementIdCompat.GetValue(view.Id),
                    name = view.Name,
                    scale = view.Scale,
                    detailLevel,
                    discipline,
                    sectionBox,
                    cropBox,
                    underlay,
                    phase = phase == null ? null : new { id = RevitBridge.Common.ElementIdCompat.GetValue(phase.Id), name = phase.Name },
                    phaseFilter = phaseFilter == null ? null : new { id = RevitBridge.Common.ElementIdCompat.GetValue(phaseFilter.Id), name = phaseFilter.Name },
                    linkedModels,
                    temporaryModes,
                    viewFilters,
                    categoryOverride,
                    viewTemplate = viewTemplate?.Name,
                    viewTemplateId = RevitBridge.Common.ElementIdCompat.GetValue(viewTemplate?.Id)
                }
            };
        }

        private static object[] BuildLinkedModelsState(Document doc)
        {
            var links = new FilteredElementCollector(doc)
                .OfClass(typeof(RevitLinkInstance))
                .Cast<RevitLinkInstance>()
                .OrderBy(link => link.Name, StringComparer.OrdinalIgnoreCase)
                .ToArray();

            return links.Select(link =>
            {
                Document? linkDoc = null;
                try { linkDoc = link.GetLinkDocument(); } catch { }
                var linkType = doc.GetElement(link.GetTypeId()) as RevitLinkType;
                return new
                {
                    instanceId = RevitBridge.Common.ElementIdCompat.GetValue(link.Id),
                    instanceName = link.Name,
                    typeId = RevitBridge.Common.ElementIdCompat.GetValue(link.GetTypeId()),
                    typeName = linkType?.Name,
                    isLoaded = linkDoc != null,
                    documentTitle = linkDoc?.Title,
                    pathName = SafePathName(linkDoc),
                    phases = BuildPhaseInventory(linkDoc),
                    commonCategories = BuildLinkedCategoryInventory(linkDoc),
                    phaseMap = BuildPhaseMapState(doc, linkDoc, linkType)
                };
            }).Cast<object>().ToArray();
        }

        private static string? SafePathName(Document? doc)
        {
            if (doc == null) return null;
            try { return doc.PathName; } catch { return null; }
        }

        private static object[] BuildPhaseInventory(Document? doc)
        {
            if (doc == null) return Array.Empty<object>();
            try
            {
                return new FilteredElementCollector(doc)
                    .OfClass(typeof(Phase))
                    .Cast<Phase>()
                    .OrderBy(phase => RevitBridge.Common.ElementIdCompat.GetValue(phase.Id))
                    .Select(phase => new { id = RevitBridge.Common.ElementIdCompat.GetValue(phase.Id), name = phase.Name })
                    .Cast<object>()
                    .ToArray();
            }
            catch
            {
                return Array.Empty<object>();
            }
        }

        private static object[] BuildLinkedCategoryInventory(Document? linkDoc)
        {
            if (linkDoc == null) return Array.Empty<object>();
            var wanted = new HashSet<string>(StringComparer.OrdinalIgnoreCase)
            {
                "Furniture",
                "Plumbing Fixtures",
                "Generic Models",
                "Lines",
                "Specialty Equipment"
            };
            var rows = new List<object>();
            try
            {
                foreach (Category category in linkDoc.Settings.Categories)
                {
                    if (!wanted.Contains(category.Name)) continue;
                    rows.Add(new
                    {
                        id = RevitBridge.Common.ElementIdCompat.GetValue(category.Id),
                        name = category.Name
                    });
                }
            }
            catch
            {
                return Array.Empty<object>();
            }
            return rows.OrderBy(row => row.GetType().GetProperty("name")?.GetValue(row)?.ToString(), StringComparer.OrdinalIgnoreCase).ToArray();
        }

        private static object[] BuildPhaseMapState(Document hostDoc, Document? linkDoc, RevitLinkType? linkType)
        {
            if (linkDoc == null || linkType == null) return Array.Empty<object>();
            try
            {
                var method = linkType.GetType().GetMethod("GetPhaseMap", BindingFlags.Instance | BindingFlags.Public, null, Type.EmptyTypes, null);
                if (method == null) return Array.Empty<object>();
                if (method.Invoke(linkType, null) is not System.Collections.IEnumerable map) return Array.Empty<object>();
                var rows = new List<object>();
                foreach (var entry in map)
                {
                    var hostPhaseId = TryReadElementIdProperty(entry, "Key");
                    var linkedPhaseId = TryReadElementIdProperty(entry, "Value");
                    var hostPhase = hostPhaseId == null ? null : hostDoc.GetElement(hostPhaseId) as Phase;
                    var linkedPhase = linkedPhaseId == null ? null : linkDoc.GetElement(linkedPhaseId) as Phase;
                    rows.Add(new
                    {
                        hostPhaseId = RevitBridge.Common.ElementIdCompat.GetValue(hostPhaseId),
                        hostPhaseName = hostPhase?.Name,
                        linkedPhaseId = RevitBridge.Common.ElementIdCompat.GetValue(linkedPhaseId),
                        linkedPhaseName = linkedPhase?.Name
                    });
                }
                return rows.ToArray();
            }
            catch
            {
                return Array.Empty<object>();
            }
        }

        private static ElementId? TryReadElementIdProperty(object target, string propName)
        {
            try
            {
                return target.GetType().GetProperty(propName, BindingFlags.Instance | BindingFlags.Public)?.GetValue(target, null) as ElementId;
            }
            catch
            {
                return null;
            }
        }

        private static object? BuildCategoryOverrideState(Document doc, View view, string? categoryName)
        {
            var category = ResolveCategory(doc, categoryName);
            if (category == null) return null;
            OverrideGraphicSettings? ogs = null;
            try { ogs = view.GetCategoryOverrides(category.Id); } catch { }
            bool? hidden = null;
            try { hidden = view.GetCategoryHidden(category.Id); } catch { }

            var lineWeight = ogs == null ? null : TryReadInt(ogs, "ProjectionLineWeight", "GetProjectionLineWeight");
            var color = ogs == null ? null : TryReadColor(ogs, "ProjectionLineColor", "GetProjectionLineColor");
            var patternId = ogs == null ? null : TryReadElementId(ogs, "ProjectionLinePatternId", "GetProjectionLinePatternId");
            LinePatternElement? pattern = null;
            if (patternId.HasValue && patternId.Value > 0)
            {
                try { pattern = doc.GetElement(RevitBridge.Common.ElementIdCompat.Create(patternId.Value)) as LinePatternElement; } catch { }
            }

            return new
            {
                categoryId = RevitBridge.Common.ElementIdCompat.GetValue(category.Id),
                categoryName = category.Name,
                hidden,
                lineWeight,
                linePatternId = patternId,
                linePatternName = pattern?.Name,
                color
            };
        }

        private static object? BuildFilterOverrideState(Document doc, View view, ElementId filterId)
        {
            OverrideGraphicSettings? ogs = null;
            try { ogs = view.GetFilterOverrides(filterId); } catch { }
            if (ogs == null) return null;

            var lineWeight = TryReadInt(ogs, "ProjectionLineWeight", "GetProjectionLineWeight");
            var color = TryReadColor(ogs, "ProjectionLineColor", "GetProjectionLineColor");
            var patternId = TryReadElementId(ogs, "ProjectionLinePatternId", "GetProjectionLinePatternId");
            LinePatternElement? pattern = null;
            if (patternId.HasValue && patternId.Value > 0)
            {
                try { pattern = doc.GetElement(RevitBridge.Common.ElementIdCompat.Create(patternId.Value)) as LinePatternElement; } catch { }
            }

            return new
            {
                lineWeight,
                linePatternId = patternId,
                linePatternName = pattern?.Name,
                color
            };
        }

        private static int? TryReadInt(object target, string propertyName, string methodName)
        {
            try
            {
                var prop = target.GetType().GetProperty(propertyName, BindingFlags.Instance | BindingFlags.Public);
                var raw = prop?.GetValue(target, null);
                if (raw is int value) return value;
            }
            catch
            {
                // ignore
            }
            try
            {
                var method = target.GetType().GetMethod(methodName, BindingFlags.Instance | BindingFlags.Public, Type.DefaultBinder, Type.EmptyTypes, null);
                var raw = method?.Invoke(target, null);
                if (raw is int value) return value;
            }
            catch
            {
                // ignore
            }
            return null;
        }

        private static long? TryReadElementId(object target, string propertyName, string methodName)
        {
            object? raw = null;
            try
            {
                var prop = target.GetType().GetProperty(propertyName, BindingFlags.Instance | BindingFlags.Public);
                raw = prop?.GetValue(target, null);
            }
            catch
            {
                // ignore
            }
            if (raw == null)
            {
                try
                {
                    var method = target.GetType().GetMethod(methodName, BindingFlags.Instance | BindingFlags.Public, Type.DefaultBinder, Type.EmptyTypes, null);
                    raw = method?.Invoke(target, null);
                }
                catch
                {
                    // ignore
                }
            }
            return raw is ElementId id ? RevitBridge.Common.ElementIdCompat.GetValue(id) : null;
        }

        private static object? TryReadColor(object target, string propertyName, string methodName)
        {
            object? raw = null;
            try
            {
                var prop = target.GetType().GetProperty(propertyName, BindingFlags.Instance | BindingFlags.Public);
                raw = prop?.GetValue(target, null);
            }
            catch
            {
                // ignore
            }
            if (raw == null)
            {
                try
                {
                    var method = target.GetType().GetMethod(methodName, BindingFlags.Instance | BindingFlags.Public, Type.DefaultBinder, Type.EmptyTypes, null);
                    raw = method?.Invoke(target, null);
                }
                catch
                {
                    // ignore
                }
            }
            if (raw is not Color color) return null;
            try
            {
                return color.IsValid ? new { r = (int)color.Red, g = (int)color.Green, b = (int)color.Blue } : null;
            }
            catch
            {
                return null;
            }
        }

        private static string? TryReadProperty(object target, string propName)
        {
            try
            {
                var p = target.GetType().GetProperty(propName, BindingFlags.Instance | BindingFlags.Public);
                var raw = p?.GetValue(target, null);
                return raw?.ToString();
            }
            catch
            {
                return null;
            }
        }
    }
}

