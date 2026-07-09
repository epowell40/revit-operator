
using System;
using System.Collections.Generic;
using System.Linq;
using System.Reflection;
using System.Text.Json;
using System.Threading.Tasks;
using Autodesk.Revit.DB;
using Autodesk.Revit.UI;
using RevitBridge.Common;

namespace RevitBridge.Logic.Handlers
{
    public class CreateScheduleHandler : IRequestHandler
    {
        public sealed class SheetPlacement
        {
            public long? sheetId { get; set; }
            public string? sheetNumber { get; set; }
            public string? query { get; set; }
            public bool? exact { get; set; }
            public double? x { get; set; }
            public double? y { get; set; }
        }

        public class ScheduleRequest
        {
            public string? name { get; set; }
            public string? scheduleName { get; set; }

            public string? category { get; set; }
            public string? categoryName { get; set; }

            public string? kind { get; set; } // regular|material_takeoff|key|multi_category|sheet_list|view_list|clone
            public long? sourceScheduleId { get; set; }
            public string? sourceQuery { get; set; }
            public bool? sourceExact { get; set; }

            public List<string>? fields { get; set; }
            public List<string>? addFields { get; set; }

            public bool? includeLinkedFiles { get; set; }
            public bool? reuseIfExists { get; set; }
            public bool? dryRun { get; set; }
            public bool? filterBySheet { get; set; }
            public bool? placeOnActiveSheet { get; set; }
            public double? placeOnActiveSheetX { get; set; }
            public double? placeOnActiveSheetY { get; set; }

            public SheetPlacement? placeOnSheet { get; set; }
        }

        public class ScheduleResult
        {
            public long viewId { get; set; }
            public bool created { get; set; }
            public string? error { get; set; }
        }

        private enum ScheduleKind
        {
            Regular,
            MaterialTakeoff,
            Key,
            KeynoteLegend,
            MultiCategory,
            SheetList,
            ViewList,
            Clone
        }

        public Task<object> Handle(UIApplication app, string jsonData)
        {
            var p = string.IsNullOrWhiteSpace(jsonData)
                ? new ScheduleRequest()
                : (JsonSerializer.Deserialize<ScheduleRequest>(jsonData) ?? new ScheduleRequest());

            var doc = app.ActiveUIDocument?.Document;
            if (doc == null) throw new InvalidOperationException("No active Revit document.");

            var scheduleName = ResolveScheduleName(p);
            if (string.IsNullOrWhiteSpace(scheduleName))
                throw new InvalidOperationException("create-schedule.name (or scheduleName) is required.");

            var kind = ParseKind(p.kind);
            var requestedFields = MergeFieldNames(p);
            var reuseIfExists = p.reuseIfExists ?? true;
            var dryRun = p.dryRun ?? false;
            var activeView = app.ActiveUIDocument.ActiveView;
            var activeSheet = activeView as ViewSheet;

            var existing = FindScheduleByName(doc, scheduleName);
            var source = ResolveSourceSchedule(doc, p, kind);
            var effectivePlacement = ResolveEffectivePlacement(p, activeSheet);
            var requestedFilterBySheet = ResolveRequestedFilterBySheet(p, kind);

            if (dryRun)
            {
                var categoryToken = ResolveCategoryToken(p, kind);
                var categoryId = TryResolveCategoryId(doc, categoryToken, kind, out var categoryError);
                var targetSheet = effectivePlacement == null ? null : ResolveSheet(doc, effectivePlacement);
                return Task.FromResult<object>(new
                {
                    status = "Dry Run",
                    dryRun = true,
                    requested = new
                    {
                        name = scheduleName,
                        kind = kind.ToString(),
                        category = categoryToken,
                        addFields = requestedFields,
                        includeLinkedFiles = p.includeLinkedFiles,
                        filterBySheet = requestedFilterBySheet,
                        reuseIfExists
                    },
                    activeView = new
                    {
                        id = ElementIdCompat.GetValue(activeView.Id),
                        name = activeView.Name,
                        kind = activeSheet == null ? "view" : "sheet",
                        sheetId = activeSheet == null ? (long?)null : ElementIdCompat.GetValue(activeSheet.Id),
                        sheetNumber = activeSheet?.SheetNumber
                    },
                    existing = existing == null ? null : new { id = ElementIdCompat.GetValue(existing.Id), name = existing.Name },
                    source = source == null ? null : new { id = ElementIdCompat.GetValue(source.Id), name = source.Name },
                    categoryResolution = new
                    {
                        resolved = categoryId != null,
                        categoryId = categoryId == null ? (long?)null : ElementIdCompat.GetValue(categoryId),
                        error = categoryError
                    },
                    placeOnSheet = effectivePlacement == null ? null : new
                    {
                        requested = true,
                        placeOnActiveSheet = p.placeOnActiveSheet ?? false,
                        target = targetSheet == null ? null : new
                        {
                            sheetId = ElementIdCompat.GetValue(targetSheet.Id),
                            targetSheet.SheetNumber,
                            targetSheet.Name
                        },
                        x = effectivePlacement.x ?? 0,
                        y = effectivePlacement.y ?? 0
                    }
                });
            }

            var result = new ScheduleResult();
            try
            {
                ViewSchedule schedule;
                var created = false;
                var includeLinkedApplied = (bool?)null;
                var filterBySheetApplied = (bool?)null;
                var placed = (object?)null;

                if (existing != null && reuseIfExists)
                {
                    schedule = existing;
                }
                else
                {
                    using (var t = new Transaction(doc, "Create Schedule"))
                    {
                        t.Start();
                        schedule = CreateSchedule(doc, scheduleName, p, kind, source, activeView?.Id);
                        AddFields(doc, schedule, requestedFields);
                        if (p.includeLinkedFiles.HasValue)
                        {
                            includeLinkedApplied = TrySetIncludeLinkedFiles(schedule, p.includeLinkedFiles.Value);
                        }
                        t.Commit();
                    }
                    created = true;
                }

                if (requestedFilterBySheet.HasValue)
                {
                    using (var t = new Transaction(doc, "Configure Schedule Filter By Sheet"))
                    {
                        t.Start();
                        filterBySheetApplied = TrySetFilterBySheet(schedule, requestedFilterBySheet.Value);
                        t.Commit();
                    }
                }

                if (effectivePlacement != null)
                {
                    using (var t = new Transaction(doc, "Place Schedule On Sheet"))
                    {
                        t.Start();
                        placed = PlaceScheduleOnSheet(doc, schedule, effectivePlacement);
                        t.Commit();
                    }
                }

                result.viewId = ElementIdCompat.GetValue(schedule.Id);
                result.created = created;

                return Task.FromResult<object>(new
                {
                    status = "Success",
                    viewId = result.viewId,
                    created = result.created,
                    schedule = new
                    {
                        id = ElementIdCompat.GetValue(schedule.Id),
                        name = schedule.Name,
                        kind = kind.ToString(),
                        fieldCount = SafeGetFieldCount(schedule.Definition)
                    },
                    includeLinkedFiles = p.includeLinkedFiles.HasValue
                        ? new { requested = p.includeLinkedFiles.Value, applied = includeLinkedApplied, current = TryGetIncludeLinkedFiles(schedule) }
                        : null,
                    filterBySheet = requestedFilterBySheet.HasValue
                        ? new { requested = requestedFilterBySheet.Value, applied = filterBySheetApplied, current = TryGetFilterBySheet(schedule) }
                        : null,
                    placedOnSheet = placed
                });
            }
            catch (Exception ex)
            {
                result.error = ex.Message;
                return Task.FromResult<object>(result);
            }
        }

        private static string ResolveScheduleName(ScheduleRequest p)
        {
            return (p.name ?? p.scheduleName ?? string.Empty).Trim();
        }

        private static List<string> MergeFieldNames(ScheduleRequest p)
        {
            return (p.addFields ?? p.fields ?? new List<string>())
                .Select(x => (x ?? string.Empty).Trim())
                .Where(x => x.Length > 0)
                .Distinct(StringComparer.OrdinalIgnoreCase)
                .ToList();
        }

        private static ScheduleKind ParseKind(string? value)
        {
            var key = (value ?? "regular").Trim().ToLowerInvariant().Replace('-', '_').Replace(' ', '_');
            return key switch
            {
                "regular" => ScheduleKind.Regular,
                "material_takeoff" => ScheduleKind.MaterialTakeoff,
                "material" => ScheduleKind.MaterialTakeoff,
                "takeoff" => ScheduleKind.MaterialTakeoff,
                "key" => ScheduleKind.Key,
                "key_schedule" => ScheduleKind.Key,
                "keynote_legend" => ScheduleKind.KeynoteLegend,
                "keynote" => ScheduleKind.KeynoteLegend,
                "legend" => ScheduleKind.KeynoteLegend,
                "multi_category" => ScheduleKind.MultiCategory,
                "multicategory" => ScheduleKind.MultiCategory,
                "sheet_list" => ScheduleKind.SheetList,
                "view_list" => ScheduleKind.ViewList,
                "clone" => ScheduleKind.Clone,
                _ => ScheduleKind.Regular
            };
        }

        private static string? ResolveCategoryToken(ScheduleRequest p, ScheduleKind kind)
        {
            if (!string.IsNullOrWhiteSpace(p.category)) return p.category!.Trim();
            if (!string.IsNullOrWhiteSpace(p.categoryName)) return p.categoryName!.Trim();

            return kind switch
            {
                ScheduleKind.SheetList => "OST_Sheets",
                ScheduleKind.ViewList => "OST_Views",
                ScheduleKind.KeynoteLegend => "OST_KeynoteTags",
                ScheduleKind.MultiCategory => "MULTI_CATEGORY",
                _ => null
            };
        }

        private static ViewSchedule? ResolveSourceSchedule(Document doc, ScheduleRequest p, ScheduleKind kind)
        {
            var needsSource = kind == ScheduleKind.Clone ||
                              (p.sourceScheduleId.HasValue && p.sourceScheduleId.Value > 0) ||
                              !string.IsNullOrWhiteSpace(p.sourceQuery);
            if (!needsSource) return null;

            if (p.sourceScheduleId.HasValue && p.sourceScheduleId.Value > 0)
            {
                return doc.GetElement(ElementIdCompat.Create(p.sourceScheduleId.Value)) as ViewSchedule;
            }

            var query = (p.sourceQuery ?? string.Empty).Trim();
            if (query.Length == 0) return null;
            var exact = p.sourceExact ?? false;

            return CollectSchedules(doc)
                .Where(s =>
                {
                    var n = (s.Name ?? string.Empty).Trim();
                    return exact
                        ? n.Equals(query, StringComparison.OrdinalIgnoreCase)
                        : n.IndexOf(query, StringComparison.OrdinalIgnoreCase) >= 0;
                })
                .OrderBy(s => s.Name, StringComparer.OrdinalIgnoreCase)
                .FirstOrDefault();
        }

        private static ViewSchedule? FindScheduleByName(Document doc, string scheduleName)
        {
            return CollectSchedules(doc)
                .FirstOrDefault(s => string.Equals((s.Name ?? string.Empty).Trim(), scheduleName, StringComparison.OrdinalIgnoreCase));
        }

        private static List<ViewSchedule> CollectSchedules(Document doc)
        {
            return new FilteredElementCollector(doc)
                .OfClass(typeof(ViewSchedule))
                .Cast<ViewSchedule>()
                .Where(s => s != null)
                .Where(s => !IsTitleblockRevisionSchedule(s))
                .ToList();
        }

        private static bool IsTitleblockRevisionSchedule(ViewSchedule schedule)
        {
            try
            {
                var prop = schedule.GetType().GetProperty("IsTitleblockRevisionSchedule", BindingFlags.Instance | BindingFlags.Public);
                return prop?.GetValue(schedule, null) is bool b && b;
            }
            catch
            {
                return false;
            }
        }

        private static ViewSchedule CreateSchedule(Document doc, string scheduleName, ScheduleRequest p, ScheduleKind kind, ViewSchedule? source, ElementId? activeViewId)
        {
            if (kind == ScheduleKind.Clone)
            {
                if (source == null) throw new InvalidOperationException("create-schedule kind=clone requires sourceScheduleId or sourceQuery.");
                var id = source.Duplicate(ViewDuplicateOption.Duplicate);
                var clone = doc.GetElement(id) as ViewSchedule;
                if (clone == null) throw new InvalidOperationException("Failed to duplicate source schedule.");
                clone.Name = scheduleName;
                return clone;
            }

            var categoryToken = ResolveCategoryToken(p, kind);
            var categoryId = TryResolveCategoryId(doc, categoryToken, kind, out var categoryError);
            if (categoryId == null)
            {
                throw new InvalidOperationException(categoryError ?? "Unable to resolve schedule category.");
            }

            ViewSchedule schedule;
            if (kind == ScheduleKind.MaterialTakeoff)
            {
                schedule = CreateMaterialTakeoff(doc, categoryId);
            }
            else if (kind == ScheduleKind.Key)
            {
                schedule = CreateKeySchedule(doc, categoryId);
            }
            else if (kind == ScheduleKind.KeynoteLegend)
            {
                schedule = CreateKeynoteLegend(doc, categoryId, activeViewId);
            }
            else
            {
                schedule = ViewSchedule.CreateSchedule(doc, categoryId);
            }

            schedule.Name = scheduleName;
            return schedule;
        }

        private static ElementId? TryResolveCategoryId(Document doc, string? categoryToken, ScheduleKind kind, out string? error)
        {
            error = null;

            if (kind == ScheduleKind.MultiCategory) return ElementId.InvalidElementId;

            var token = (categoryToken ?? string.Empty).Trim();
            if (token.Equals("MULTI_CATEGORY", StringComparison.OrdinalIgnoreCase)) return ElementId.InvalidElementId;
            if (token.Length == 0)
            {
                error = "Category is required for this schedule kind.";
                return null;
            }

            if (Enum.TryParse(token, ignoreCase: true, out BuiltInCategory bic))
            {
                return ElementIdCompat.Create((long)bic);
            }

            var fromName = doc.Settings?.Categories?
                .Cast<Category>()
                .FirstOrDefault(c => string.Equals((c.Name ?? string.Empty).Trim(), token, StringComparison.OrdinalIgnoreCase));
            if (fromName != null) return fromName.Id;

            error = $"Invalid category '{token}'.";
            return null;
        }

        private static ViewSchedule CreateMaterialTakeoff(Document doc, ElementId categoryId)
        {
            var method = typeof(ViewSchedule).GetMethod("CreateMaterialTakeoff", BindingFlags.Public | BindingFlags.Static, null, new[] { typeof(Document), typeof(ElementId) }, null);
            if (method == null) throw new InvalidOperationException("This Revit API version does not expose material takeoff creation.");

            var raw = method.Invoke(null, new object[] { doc, categoryId });
            if (raw is ViewSchedule schedule) return schedule;
            throw new InvalidOperationException("Failed to create material takeoff schedule.");
        }

        private static ViewSchedule CreateKeySchedule(Document doc, ElementId categoryId)
        {
            var method = typeof(ViewSchedule).GetMethod("CreateKeySchedule", BindingFlags.Public | BindingFlags.Static, null, new[] { typeof(Document), typeof(ElementId) }, null);
            if (method == null) throw new InvalidOperationException("This Revit API version does not expose key schedule creation.");

            var raw = method.Invoke(null, new object[] { doc, categoryId });
            if (raw is ViewSchedule schedule) return schedule;
            throw new InvalidOperationException("Failed to create key schedule.");
        }

        private static SheetPlacement? ResolveEffectivePlacement(ScheduleRequest p, ViewSheet? activeSheet)
        {
            if (p.placeOnActiveSheet.HasValue && p.placeOnActiveSheet.Value)
            {
                if (activeSheet == null)
                {
                    throw new InvalidOperationException("placeOnActiveSheet=true requires an active sheet view.");
                }

                return new SheetPlacement
                {
                    sheetId = ElementIdCompat.GetValue(activeSheet.Id),
                    x = p.placeOnActiveSheetX ?? p.placeOnSheet?.x ?? 0,
                    y = p.placeOnActiveSheetY ?? p.placeOnSheet?.y ?? 0
                };
            }

            return p.placeOnSheet;
        }

        private static bool? ResolveRequestedFilterBySheet(ScheduleRequest p, ScheduleKind kind)
        {
            if (p.filterBySheet.HasValue) return p.filterBySheet.Value;
            if (kind == ScheduleKind.KeynoteLegend) return true;
            return null;
        }

        private static bool? TrySetFilterBySheet(ViewSchedule schedule, bool value)
        {
            try
            {
                var definition = schedule.Definition;
                foreach (var propName in new[] { "IsFilteredBySheet", "FilterBySheet", "FilteredBySheet" })
                {
                    var prop = definition.GetType().GetProperty(propName, BindingFlags.Instance | BindingFlags.Public);
                    if (prop == null || !prop.CanWrite || prop.PropertyType != typeof(bool)) continue;
                    prop.SetValue(definition, value, null);
                    return true;
                }

                return false;
            }
            catch
            {
                return false;
            }
        }

        private static bool? TryGetFilterBySheet(ViewSchedule schedule)
        {
            try
            {
                var definition = schedule.Definition;
                foreach (var propName in new[] { "IsFilteredBySheet", "FilterBySheet", "FilteredBySheet" })
                {
                    var prop = definition.GetType().GetProperty(propName, BindingFlags.Instance | BindingFlags.Public);
                    if (prop == null || !prop.CanRead) continue;

                    var raw = prop.GetValue(definition, null);
                    if (raw is bool b) return b;
                }
            }
            catch
            {
                // ignore
            }

            return null;
        }

        private static ViewSchedule CreateKeynoteLegend(Document doc, ElementId categoryId, ElementId? activeViewId)
        {
            var methods = typeof(ViewSchedule)
                .GetMethods(BindingFlags.Public | BindingFlags.Static)
                .Where(m => m.Name.IndexOf("Create", StringComparison.OrdinalIgnoreCase) >= 0 &&
                            m.Name.IndexOf("Keynote", StringComparison.OrdinalIgnoreCase) >= 0)
                .OrderBy(m => m.GetParameters().Length)
                .ToList();

            foreach (var method in methods)
            {
                if (!TryBuildKeynoteFactoryArguments(method, doc, categoryId, activeViewId, out var args)) continue;
                try
                {
                    var raw = method.Invoke(null, args);
                    if (raw is ViewSchedule schedule) return schedule;
                }
                catch
                {
                    // try next API candidate
                }
            }

            try
            {
                var createNoteBlock = typeof(ViewSchedule).GetMethod(
                    "CreateNoteBlock",
                    BindingFlags.Public | BindingFlags.Static,
                    null,
                    new[] { typeof(Document), typeof(ElementId) },
                    null);
                if (createNoteBlock != null)
                {
                    var raw = createNoteBlock.Invoke(null, new object[] { doc, categoryId });
                    if (raw is ViewSchedule noteBlock) return noteBlock;
                }
            }
            catch
            {
                // ignore and fall back
            }

            return ViewSchedule.CreateSchedule(doc, categoryId);
        }

        private static bool TryBuildKeynoteFactoryArguments(MethodInfo method, Document doc, ElementId categoryId, ElementId? activeViewId, out object?[] args)
        {
            var parameters = method.GetParameters();
            args = new object?[parameters.Length];
            var hasDocumentParameter = false;

            for (var i = 0; i < parameters.Length; i++)
            {
                var parameter = parameters[i];
                var parameterName = (parameter.Name ?? string.Empty).Trim().ToLowerInvariant();

                if (parameter.ParameterType == typeof(Document))
                {
                    args[i] = doc;
                    hasDocumentParameter = true;
                    continue;
                }

                if (parameter.ParameterType == typeof(ElementId))
                {
                    if (parameterName.Contains("category") || parameterName.Contains("cat"))
                    {
                        args[i] = categoryId;
                        continue;
                    }

                    if (parameterName.Contains("view"))
                    {
                        args[i] = IsValidElementId(activeViewId) ? activeViewId! : ElementId.InvalidElementId;
                        continue;
                    }

                    args[i] = IsValidElementId(activeViewId) ? activeViewId! : categoryId;
                    continue;
                }

                if (parameter.ParameterType == typeof(View))
                {
                    var view = IsValidElementId(activeViewId) ? doc.GetElement(activeViewId!) as View : null;
                    args[i] = view;
                    continue;
                }

                if (parameter.ParameterType == typeof(BuiltInCategory))
                {
                    args[i] = BuiltInCategory.OST_KeynoteTags;
                    continue;
                }

                if (parameter.HasDefaultValue)
                {
                    args[i] = parameter.DefaultValue;
                    continue;
                }

                if (!parameter.ParameterType.IsValueType)
                {
                    args[i] = null;
                    continue;
                }

                args[i] = Activator.CreateInstance(parameter.ParameterType);
            }

            return hasDocumentParameter;
        }

        private static bool IsValidElementId(ElementId? id)
        {
            if (id == null) return false;
            try
            {
                return id != ElementId.InvalidElementId && id.IntegerValue != -1;
            }
            catch
            {
                return id != ElementId.InvalidElementId;
            }
        }

        private static void AddFields(Document doc, ViewSchedule schedule, List<string> fieldNames)
        {
            if (fieldNames.Count == 0) return;

            var existing = GetFieldNames(doc, schedule);
            var schedulable = GetSchedulableFields(doc, schedule);

            foreach (var name in fieldNames)
            {
                if (existing.Contains(name)) continue;

                if (schedulable.TryGetValue(name, out var sField))
                {
                    TryAddField(schedule.Definition, sField);
                }
            }
        }

        private static HashSet<string> GetFieldNames(Document doc, ViewSchedule schedule)
        {
            var set = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            var count = SafeGetFieldCount(schedule.Definition);
            for (var i = 0; i < count; i++)
            {
                try
                {
                    var field = schedule.Definition.GetField(i);
                    var name = ReadFieldName(doc, field);
                    if (!string.IsNullOrWhiteSpace(name)) set.Add(name.Trim());
                }
                catch
                {
                    // ignore
                }
            }
            return set;
        }

        private static Dictionary<string, SchedulableField> GetSchedulableFields(Document doc, ViewSchedule schedule)
        {
            var map = new Dictionary<string, SchedulableField>(StringComparer.OrdinalIgnoreCase);
            try
            {
                foreach (var field in schedule.Definition.GetSchedulableFields())
                {
                    var name = field.GetName(doc);
                    if (string.IsNullOrWhiteSpace(name)) continue;
                    map[name.Trim()] = field;
                }
            }
            catch
            {
                // ignore
            }
            return map;
        }

        private static void TryAddField(ScheduleDefinition definition, SchedulableField schedulableField)
        {
            var addBySchedulable = definition.GetType().GetMethod("AddField", BindingFlags.Instance | BindingFlags.Public, null, new[] { typeof(SchedulableField) }, null);
            if (addBySchedulable != null)
            {
                addBySchedulable.Invoke(definition, new object[] { schedulableField });
                return;
            }

            var fieldType = ScheduleFieldType.Instance;
            var fieldTypeProp = schedulableField.GetType().GetProperty("FieldType", BindingFlags.Instance | BindingFlags.Public);
            if (fieldTypeProp?.GetValue(schedulableField, null) is ScheduleFieldType resolved)
            {
                fieldType = resolved;
            }

            definition.AddField(fieldType, schedulableField.ParameterId);
        }

        private static string? ReadFieldName(Document doc, ScheduleField field)
        {
            try
            {
                var noArg = field.GetType().GetMethod("GetName", BindingFlags.Instance | BindingFlags.Public, null, Type.EmptyTypes, null);
                if (noArg != null)
                {
                    var name = noArg.Invoke(field, null)?.ToString();
                    if (!string.IsNullOrWhiteSpace(name)) return name;
                }

                var withDoc = field.GetType().GetMethod("GetName", BindingFlags.Instance | BindingFlags.Public, null, new[] { typeof(Document) }, null);
                if (withDoc != null)
                {
                    var name = withDoc.Invoke(field, new object[] { doc })?.ToString();
                    if (!string.IsNullOrWhiteSpace(name)) return name;
                }
            }
            catch
            {
                // ignore
            }

            return null;
        }

        private static int SafeGetFieldCount(ScheduleDefinition definition)
        {
            try { return definition.GetFieldCount(); }
            catch { return 0; }
        }

        private static bool? TrySetIncludeLinkedFiles(ViewSchedule schedule, bool value)
        {
            try
            {
                var definition = schedule.Definition;
                var prop = definition.GetType().GetProperty("IncludeLinkedFiles", BindingFlags.Instance | BindingFlags.Public);
                if (prop == null || !prop.CanWrite || prop.PropertyType != typeof(bool)) return false;
                prop.SetValue(definition, value, null);
                return true;
            }
            catch
            {
                return false;
            }
        }

        private static bool? TryGetIncludeLinkedFiles(ViewSchedule schedule)
        {
            try
            {
                var definition = schedule.Definition;
                var prop = definition.GetType().GetProperty("IncludeLinkedFiles", BindingFlags.Instance | BindingFlags.Public);
                return prop?.GetValue(definition, null) as bool?;
            }
            catch
            {
                return null;
            }
        }

        private static object PlaceScheduleOnSheet(Document doc, ViewSchedule schedule, SheetPlacement placement)
        {
            var sheet = ResolveSheet(doc, placement);
            if (sheet == null) throw new InvalidOperationException("placeOnSheet requires sheetId, sheetNumber, or query.");

            var existing = new FilteredElementCollector(doc, sheet.Id)
                .OfClass(typeof(ScheduleSheetInstance))
                .Cast<ScheduleSheetInstance>()
                .FirstOrDefault(ssi => ssi.ScheduleId == schedule.Id);
            if (existing != null)
            {
                var existingBounds = TryGetSheetBoundingBox(existing, sheet);
                return new
                {
                    status = "AlreadyPlaced",
                    scheduleSheetInstanceId = ElementIdCompat.GetValue(existing.Id),
                    sheetId = ElementIdCompat.GetValue(sheet.Id),
                    sheetNumber = sheet.SheetNumber,
                    boundingBox = existingBounds
                };
            }

            var x = placement.x ?? 0;
            var y = placement.y ?? 0;
            var placed = ScheduleSheetInstance.Create(doc, sheet.Id, schedule.Id, new XYZ(x, y, 0));
            return new
            {
                status = "Placed",
                scheduleSheetInstanceId = ElementIdCompat.GetValue(placed.Id),
                sheetId = ElementIdCompat.GetValue(sheet.Id),
                sheetNumber = sheet.SheetNumber,
                x,
                y,
                boundingBox = TryGetSheetBoundingBox(placed, sheet)
            };
        }

        private static object? TryGetSheetBoundingBox(Element element, ViewSheet sheet)
        {
            try
            {
                var bbox = element.get_BoundingBox(sheet);
                if (bbox == null) return null;
                return new
                {
                    min = new { x = bbox.Min.X, y = bbox.Min.Y, z = bbox.Min.Z },
                    max = new { x = bbox.Max.X, y = bbox.Max.Y, z = bbox.Max.Z },
                    width = Math.Abs(bbox.Max.X - bbox.Min.X),
                    height = Math.Abs(bbox.Max.Y - bbox.Min.Y)
                };
            }
            catch
            {
                return null;
            }
        }

        private static ViewSheet? ResolveSheet(Document doc, SheetPlacement placement)
        {
            if (placement.sheetId.HasValue && placement.sheetId.Value > 0)
            {
                var byId = doc.GetElement(ElementIdCompat.Create(placement.sheetId.Value)) as ViewSheet;
                if (byId != null && !byId.IsPlaceholder) return byId;
            }

            var number = (placement.sheetNumber ?? string.Empty).Trim();
            if (number.Length > 0)
            {
                return new FilteredElementCollector(doc)
                    .OfClass(typeof(ViewSheet))
                    .Cast<ViewSheet>()
                    .FirstOrDefault(s => !s.IsPlaceholder && string.Equals((s.SheetNumber ?? string.Empty).Trim(), number, StringComparison.OrdinalIgnoreCase));
            }

            var query = (placement.query ?? string.Empty).Trim();
            if (query.Length == 0) return null;
            var exact = placement.exact ?? false;

            return new FilteredElementCollector(doc)
                .OfClass(typeof(ViewSheet))
                .Cast<ViewSheet>()
                .Where(s => !s.IsPlaceholder)
                .Where(s =>
                {
                    var sn = (s.SheetNumber ?? string.Empty).Trim();
                    var nm = (s.Name ?? string.Empty).Trim();
                    return exact
                        ? sn.Equals(query, StringComparison.OrdinalIgnoreCase) || nm.Equals(query, StringComparison.OrdinalIgnoreCase)
                        : sn.IndexOf(query, StringComparison.OrdinalIgnoreCase) >= 0 || nm.IndexOf(query, StringComparison.OrdinalIgnoreCase) >= 0;
                })
                .OrderBy(s => s.SheetNumber, StringComparer.OrdinalIgnoreCase)
                .ThenBy(s => s.Name, StringComparer.OrdinalIgnoreCase)
                .FirstOrDefault();
        }
    }
}
