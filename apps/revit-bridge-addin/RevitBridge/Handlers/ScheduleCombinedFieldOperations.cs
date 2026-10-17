using System;
using System.Collections.Generic;
using System.Linq;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Autodesk.Revit.DB;
using Autodesk.Revit.UI;
using RevitBridge.Common;

namespace RevitBridge.Handlers
{
    internal static class ScheduleCombinedFieldOperations
    {
        private static string Hash(object value)
        {
            using var sha = SHA256.Create();
            return BitConverter.ToString(sha.ComputeHash(Encoding.UTF8.GetBytes(JsonSerializer.Serialize(value)))).Replace("-", "").ToLowerInvariant();
        }
        private static object[] Parts(ScheduleField field)
        {
            if (!field.IsCombinedParameterField) return Array.Empty<object>();
            var parts = field.GetCombinedParameters();
            try { return parts.Select(p => (object)new { parameterId = ElementIdCompat.GetValue(p.ParamId), categoryId = ElementIdCompat.GetValue(p.CategoryId),
                prefix = p.Prefix, suffix = p.Suffix, separator = p.Separator, sampleValue = p.SampleValue }).ToArray(); }
            finally { foreach (var part in parts) part.Dispose(); }
        }
        private static object Field(Document doc, ScheduleField field)
        {
            using var style = field.GetStyle();
            var parts = Parts(field);
            var attributes = new { fieldId = field.FieldId.IntegerValue, name = field.GetName(),
                parameterId = ElementIdCompat.GetValue(field.ParameterId), parameterUniqueId = ElementIdCompat.GetValue(field.ParameterId) > 0 ? doc.GetElement(field.ParameterId)?.UniqueId : null,
                fieldType = field.FieldType.ToString(), isCalculated = field.IsCalculatedField, isCombined = field.IsCombinedParameterField,
                heading = field.ColumnHeading, headingOrientation = field.HeadingOrientation.ToString(), horizontalAlignment = field.HorizontalAlignment.ToString(),
                gridWidthFeet = field.GridColumnWidth, sheetWidthFeet = field.SheetColumnWidth,
                style = ScheduleCellAppearanceOperations.Style(style, includePreservedProperties: true), parts };
            return new { fieldId = field.FieldId.IntegerValue, isHidden = field.IsHidden, attributes, semanticHash = Hash(attributes) };
        }
        internal static object Read(Document doc, ViewSchedule schedule)
        {
            try
            {
                var order = schedule.Definition.GetFieldOrder().Select(f => f.IntegerValue).ToArray();
                if (order.Length > 200) throw new InvalidOperationException("Combined-field definition read is bounded to200fields.");
                var state = JsonSerializer.SerializeToElement(SchedulesHandler.ReadPresentationScopeState(doc, schedule));
                var configuration = new Dictionary<string, object?>();
                foreach (var property in state.EnumerateObject())
                {
                    if (property.Name == "fields") continue;
                    if (property.Name == "presentation")
                        configuration[property.Name] = property.Value.EnumerateObject().Where(p => p.Name != "fieldOrder").ToDictionary(p => p.Name, p => (object)p.Value.Clone());
                    else configuration[property.Name] = property.Value.Clone();
                }
                return new { schema = "operator.regular_schedule_field_definition.v1", complete = true,
                    scheduleId = ElementIdCompat.GetValue(schedule.Id), uniqueId = schedule.UniqueId, categoryId = ElementIdCompat.GetValue(schedule.Definition.CategoryId),
                    fieldOrder = order, fields = order.Select(id => Field(doc, schedule.Definition.GetField(new ScheduleFieldId(id)))).ToArray(),
                    configurationHash = Hash(configuration),
                    coverage = "native_field_binding_captured_attributes_filters_sort_defaults_parameters_v1" };
            }
            catch (Exception ex) { return new { schema = "operator.regular_schedule_field_definition.v1", complete = false, error = ex.Message }; }
        }
        private static JsonElement Complete(object snapshot)
        {
            var value = JsonSerializer.SerializeToElement(snapshot);
            if (!value.GetProperty("complete").GetBoolean()) throw new InvalidOperationException("Cannot fully observe native field definition: " + value.GetProperty("error").GetString());
            return value;
        }
        private static string StableFields(JsonElement snapshot, ISet<int> allowedHidden)
            => Hash(snapshot.GetProperty("fields").EnumerateArray().Where(f => !allowedHidden.Contains(f.GetProperty("fieldId").GetInt32()))
                .Select(f => new { id = f.GetProperty("fieldId").GetInt32(), hash = f.GetProperty("semanticHash").GetString(), hidden = f.GetProperty("isHidden").GetBoolean() }).OrderBy(f => f.id).ToArray());

        internal static Dictionary<string, object?> Edit(UIApplication app, Document doc, long scheduleId, ScheduleCombinedFieldSpec spec, bool dryRun)
        {
            ViewSchedule schedule; object before; int index; int[] sourceIds; string name; string separator;
            try
            {
                schedule = doc.GetElement(ElementIdCompat.Create(scheduleId)) as ViewSchedule ?? throw new ArgumentException("One actual regular ViewSchedule is required.");
                if (schedule.IsTemplate || schedule.IsTitleblockRevisionSchedule) throw new ArgumentException("Schedule templates and revision schedules cannot be changed by this operation.");
                before = Read(doc, schedule); var b = Complete(before); sourceIds = spec.sourceFieldIds!.ToArray(); name = spec.name!.Trim(); separator = spec.separator ?? " / ";
                var order = b.GetProperty("fieldOrder").EnumerateArray().Select(f => f.GetInt32()).ToArray();
                if (order.Length >= 200) throw new ArgumentException("Adding a field would exceed the200-field bound.");
                foreach (var id in sourceIds)
                {
                    if (!order.Contains(id)) throw new ArgumentException("Source schedule field does not exist: " + id);
                    var field = schedule.Definition.GetField(new ScheduleFieldId(id));
                    if (field.IsCalculatedField || field.IsCombinedParameterField || field.ParameterId == ElementId.InvalidElementId)
                        throw new ArgumentException("Sources must be native schedulable parameter fields; calculated/count/combined fields are not parameter bindings.");
                }
                if (sourceIds.Select(id => ElementIdCompat.GetValue(schedule.Definition.GetField(new ScheduleFieldId(id)).ParameterId)).Distinct().Count() != sourceIds.Length)
                    throw new ArgumentException("Each source must bind a different native parameter.");
                index = spec.index ?? Array.IndexOf(order, sourceIds[0]);
                if (index < 0 || index > order.Length) throw new ArgumentException("Insertion index is outside the full native field order.");
                if (order.Any(id => string.Equals(schedule.Definition.GetField(new ScheduleFieldId(id)).GetName(), name, StringComparison.OrdinalIgnoreCase)))
                    throw new ArgumentException("A field already uses that name. Inspect it instead of adding or overwriting another field.");
            }
            catch (Exception ex) { return new Dictionary<string, object?> { ["status"] = "Blocked", ["error"] = ex.Message, ["transaction"] = OperatorNativeTransactionReceipt.NotStarted() }; }
            if (dryRun) return new Dictionary<string, object?> { ["status"] = "Dry Run", ["dryRun"] = true, ["previewExecuted"] = false,
                ["schedule"] = new { id = scheduleId, uniqueId = schedule.UniqueId }, ["definitionBefore"] = before,
                ["plan"] = new { name, sourceFieldIds = sourceIds, index, separator, hideSourceFields = spec.hideSourceFields ?? true, widthFeet = spec.widthFeet },
                ["transaction"] = OperatorNativeTransactionReceipt.NotStarted() };
            var scopeBefore = RegularSchedulePresentationScope.Capture(doc, schedule); Complete(scopeBefore);
            int? addedFieldId = null;
            var result = RevitBridge.Logic.Handlers.NativeSingleTransaction.Execute(app, doc, "Combine schedule parameter fields", created =>
            {
                var data = new List<TableCellCombinedParameterData>();
                try
                {
                    for (var i = 0; i < sourceIds.Length; i++)
                    {
                        var part = TableCellCombinedParameterData.Create();
                        part.ParamId = schedule.Definition.GetField(new ScheduleFieldId(sourceIds[i])).ParameterId;
                        part.Prefix = ""; part.Suffix = ""; part.Separator = i + 1 < sourceIds.Length ? separator : "";
                        data.Add(part);
                    }
                    var combined = schedule.Definition.InsertCombinedParameterField(data, name, index);
                    addedFieldId = combined.FieldId.IntegerValue; combined.ColumnHeading = name;
                    if (spec.widthFeet.HasValue) { combined.GridColumnWidth = spec.widthFeet.Value; combined.SheetColumnWidth = spec.widthFeet.Value; }
                    if (spec.hideSourceFields ?? true) foreach (var id in sourceIds) schedule.Definition.GetField(new ScheduleFieldId(id)).IsHidden = true;
                    doc.Regenerate(); var after = Read(doc, schedule); var b = Complete(before); var a = Complete(after);
                    if (!combined.IsCombinedParameterField || combined.IsHidden || combined.GetName() != name || combined.ColumnHeading != name
                        || (spec.widthFeet.HasValue && (Math.Abs(combined.GridColumnWidth - spec.widthFeet.Value) > 1e-8
                            || Math.Abs(combined.SheetColumnWidth - spec.widthFeet.Value) > 1e-8)))
                        throw new InvalidOperationException("Combined field identity, heading or requested width did not read back; roll back.");
                    var observedParts = combined.GetCombinedParameters();
                    try
                    {
                        if (observedParts.Count != sourceIds.Length || observedParts.Where((part, i) =>
                            part.ParamId != schedule.Definition.GetField(new ScheduleFieldId(sourceIds[i])).ParameterId
                            || part.Prefix != "" || part.Suffix != "" || part.Separator != (i + 1 < sourceIds.Length ? separator : "")).Any())
                            throw new InvalidOperationException("Combined parameter bindings or separators did not read back; roll back.");
                    }
                    finally { foreach (var part in observedParts) part.Dispose(); }
                    var expectedOrder = b.GetProperty("fieldOrder").EnumerateArray().Select(f => f.GetInt32()).ToList(); expectedOrder.Insert(index, addedFieldId.Value);
                    if (!expectedOrder.SequenceEqual(a.GetProperty("fieldOrder").EnumerateArray().Select(f => f.GetInt32())) || b.GetProperty("configurationHash").GetString() != a.GetProperty("configurationHash").GetString())
                        throw new InvalidOperationException("Unrequested schedule configuration or native field order changed; roll back.");
                    var excluded = new HashSet<int>(sourceIds) { addedFieldId.Value };
                    if (StableFields(b, excluded) != StableFields(a, excluded)) throw new InvalidOperationException("Unrequested field bindings or captured formatting changed; roll back.");
                    foreach (var id in sourceIds)
                    {
                        var old = b.GetProperty("fields").EnumerateArray().Single(f => f.GetProperty("fieldId").GetInt32() == id);
                        var current = a.GetProperty("fields").EnumerateArray().Single(f => f.GetProperty("fieldId").GetInt32() == id);
                        if (old.GetProperty("semanticHash").GetString() != current.GetProperty("semanticHash").GetString()
                            || current.GetProperty("isHidden").GetBoolean() != ((spec.hideSourceFields ?? true) || old.GetProperty("isHidden").GetBoolean()))
                            throw new InvalidOperationException("Source binding/captured formatting changed unexpectedly; roll back.");
                    }
                    // ScheduleFieldId is scoped to this schedule, not an ElementId. Only
                    // actual DocumentChanged IDs belong in the native effect inventory.
                    return new Dictionary<string, object?> { ["definitionBefore"] = before, ["definitionAfter"] = after,
                        ["createdScheduleFieldId"] = addedFieldId, ["sourceFieldIds"] = sourceIds, ["requestedIndex"] = index };
                }
                finally { foreach (var part in data) part.Dispose(); }
            }, nativeModifiedElements: () => new[] { scheduleId });
            result["status"] = OperatorNativeTransactionExecution.OutcomeStatus(result, "Success"); result["dryRun"] = false;
            result["schedule"] = new { id = scheduleId, uniqueId = schedule.UniqueId };
            result["presentationScopeBefore"] = scopeBefore;
            if (result.TryGetValue("transaction", out var raw) && raw is OperatorNativeTransactionReceipt receipt && receipt.CommittedValue == true)
            {
                try { result["definitionAfter"] = Read(doc, schedule); result["presentationScopeAfter"] = RegularSchedulePresentationScope.Capture(doc, schedule); }
                catch (Exception ex) { result["readbackError"] = ex.Message; }
            }
            return result;
        }
    }
}
