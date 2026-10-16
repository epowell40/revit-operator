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
    internal static class ProjectParameterBindingOperations
    {
        private static string Hash(object value)
        {
            using var sha = SHA256.Create();
            return BitConverter.ToString(sha.ComputeHash(Encoding.UTF8.GetBytes(JsonSerializer.Serialize(value)))).Replace("-", "").ToLowerInvariant();
        }
        private static object Descriptor(Document doc, Definition definition, ElementBinding binding)
        {
            var native = definition as InternalDefinition ?? throw new InvalidOperationException("Binding definition has no native identity.");
            var element = doc.GetElement(native.Id) as ParameterElement ?? throw new InvalidOperationException("Native parameter element is unavailable.");
            return new { id = ElementIdCompat.GetValue(element.Id), uniqueId = element.UniqueId, name = definition.Name,
                guid = (element as SharedParameterElement)?.GuidValue.ToString("D"), dataTypeId = definition.GetDataType().TypeId,
                groupTypeId = definition.GetGroupTypeId().TypeId, visible = native.Visible, isInstance = binding is InstanceBinding,
                categories = binding.Categories.Cast<Category>().Select(c => new { id = ElementIdCompat.GetValue(c.Id), name = c.Name }).OrderBy(c => c.id).ToArray() };
        }
        internal static object[] Bindings(Document doc)
        {
            var rows = new List<object>(); var iterator = doc.ParameterBindings.ForwardIterator(); iterator.Reset();
            while (iterator.MoveNext())
            {
                if (rows.Count >= 5000) throw new InvalidOperationException("Project binding inventory exceeds 5000 definitions.");
                if (!(iterator.Current is ElementBinding binding)) throw new InvalidOperationException("Unsupported native binding.");
                rows.Add(Descriptor(doc, iterator.Key, binding));
            }
            return rows.OrderBy(v => JsonSerializer.SerializeToElement(v).GetProperty("id").GetInt64()).ToArray();
        }
        private static Element[] Owners(Document doc, IEnumerable<long> categoryIds, bool instance)
        {
            var rows = new Dictionary<long, Element>();
            foreach (var id in categoryIds)
            {
                var collector = new FilteredElementCollector(doc).OfCategoryId(ElementIdCompat.Create(id));
                if (instance) collector.WhereElementIsNotElementType(); else collector.WhereElementIsElementType();
                foreach (var element in collector)
                {
                    rows[ElementIdCompat.GetValue(element.Id)] = element;
                    if (rows.Count > 5000) throw new InvalidOperationException("Bound-owner inventory exceeds 5000 elements.");
                }
            }
            return rows.OrderBy(r => r.Key).Select(r => r.Value).ToArray();
        }
        private static object Owner(Element element, Guid guid)
        {
            var p = element.get_Parameter(guid);
            object? value = null;
            if (p != null && p.HasValue) value = p.StorageType == StorageType.String ? (object?)p.AsString()
                : p.StorageType == StorageType.Integer ? p.AsInteger() : p.StorageType == StorageType.Double ? p.AsDouble()
                : p.StorageType == StorageType.ElementId ? ElementIdCompat.GetValue(p.AsElementId()) : null;
            return new { id = ElementIdCompat.GetValue(element.Id), uniqueId = element.UniqueId, categoryId = ElementIdCompat.GetValue(element.Category.Id),
                typeId = ElementIdCompat.GetValue(element.GetTypeId()),
                hasParameter = p != null, parameterId = p == null ? (long?)null : ElementIdCompat.GetValue(p.Id),
                storage = p?.StorageType.ToString(), hasValue = p?.HasValue ?? false, value, userModifiable = p?.UserModifiable, isReadOnly = p?.IsReadOnly };
        }
        internal static object Detail(Document doc, long id)
        {
            try
            {
                var bindings = Bindings(doc); var row = bindings.Select(v => JsonSerializer.SerializeToElement(v)).Single(p => p.GetProperty("id").GetInt64() == id);
                var guid = Guid.Parse(row.GetProperty("guid").GetString()!);
                var categoryIds = row.GetProperty("categories").EnumerateArray().Select(c => c.GetProperty("id").GetInt64()).ToArray();
                var owners = Owners(doc, categoryIds, row.GetProperty("isInstance").GetBoolean()).Select(e => Owner(e, guid)).ToArray();
                return new { status = "Ok", action = "detail", read_only = true, schema = "operator.project_parameter_binding.v1", complete = true,
                    parameter = row, owners, otherBindingsHash = Hash(bindings.Where(b => JsonSerializer.SerializeToElement(b).GetProperty("id").GetInt64() != id).ToArray()),
                    coverage = "native_shared_binding_and_complete_owner_values_v1" };
            }
            catch (Exception ex) { return new { status = "Error", action = "detail", read_only = true, schema = "operator.project_parameter_binding.v1", complete = false, error = ex.Message }; }
        }
        private static JsonElement Complete(object value)
        {
            var row = JsonSerializer.SerializeToElement(value);
            if (!row.TryGetProperty("complete", out var complete) || !complete.GetBoolean()) throw new InvalidOperationException("Native binding detail is incomplete: " + row);
            return row;
        }
        internal static object Create(UIApplication app, Document doc, string name, List<Category> categories, bool instance,
            ForgeTypeId dataType, ForgeTypeId group, bool visible, bool userModifiable, bool dryRun, Func<ExternalDefinition> prepareDefinition,
            Func<object> externalEffect)
        {
            object[] before; Element[] owners;
            try
            {
                before = Bindings(doc);
                var matches = before.Select(v => JsonSerializer.SerializeToElement(v)).Where(v => string.Equals(v.GetProperty("name").GetString(), name, StringComparison.OrdinalIgnoreCase)).ToArray();
                if (matches.Length > 1) throw new InvalidOperationException("Multiple native bindings share that name; resolve their parameter IDs before editing.");
                if (matches.Length == 1) return new { status = "AlreadyExists", action = "create", parameter = matches[0],
                    message = "Existing binding was not changed. Inspect its native ID/type/categories before reusing it.", transaction = OperatorNativeTransactionReceipt.NotStarted() };
                owners = Owners(doc, categories.Select(c => ElementIdCompat.GetValue(c.Id)), instance);
            }
            catch (Exception ex) { return new { status = "Blocked", error = ex.Message, transaction = OperatorNativeTransactionReceipt.NotStarted() }; }
            if (dryRun) return new { status = "Dry Run", action = "create", dryRun = true, previewExecuted = false,
                plan = new { name, categoryIds = categories.Select(c => ElementIdCompat.GetValue(c.Id)), instance, dataTypeId = dataType.TypeId, groupTypeId = group.TypeId, visible, userModifiable },
                transaction = OperatorNativeTransactionReceipt.NotStarted() };
            ExternalDefinition definition; object[] beforeValues; long? existingId;
            try
            {
                definition = prepareDefinition();
                if (definition.GetDataType() != dataType || definition.Visible != visible || definition.UserModifiable != userModifiable)
                    throw new InvalidOperationException("Existing external definition differs in type or visibility/editability; no model transaction started.");
                existingId = SharedParameterElement.Lookup(doc, definition.GUID) is SharedParameterElement existing ? ElementIdCompat.GetValue(existing.Id) : (long?)null;
                beforeValues = owners.Select(e => Owner(e, definition.GUID)).ToArray();
            }
            catch (Exception ex) { return new { status = "Blocked", error = ex.Message, transaction = OperatorNativeTransactionReceipt.NotStarted(), externalDefinitionEffect = externalEffect() }; }
            var result = RevitBridge.Logic.Handlers.NativeSingleTransaction.Execute(app, doc, "Create project parameter binding", created =>
            {
                using var set = app.Application.Create.NewCategorySet(); foreach (var category in categories) set.Insert(category);
                using ElementBinding binding = instance ? (ElementBinding)app.Application.Create.NewInstanceBinding(set) : app.Application.Create.NewTypeBinding(set);
                if (!doc.ParameterBindings.Insert(definition, binding, group)) throw new InvalidOperationException("Native binding insertion failed; roll back.");
                doc.Regenerate(); var parameter = SharedParameterElement.Lookup(doc, definition.GUID) ?? throw new InvalidOperationException("Bound parameter identity missing; roll back.");
                var id = ElementIdCompat.GetValue(parameter.Id); if (!existingId.HasValue) created.Add(id);
                var after = Complete(Detail(doc, id));
                var descriptor = after.GetProperty("parameter");
                var expectedCategories = categories.Select(c => ElementIdCompat.GetValue(c.Id)).OrderBy(c => c).ToArray();
                if (descriptor.GetProperty("name").GetString() != name || descriptor.GetProperty("guid").GetString() != definition.GUID.ToString("D")
                    || descriptor.GetProperty("isInstance").GetBoolean() != instance || descriptor.GetProperty("dataTypeId").GetString() != dataType.TypeId
                    || descriptor.GetProperty("groupTypeId").GetString() != group.TypeId || descriptor.GetProperty("visible").GetBoolean() != visible
                    || !descriptor.GetProperty("categories").EnumerateArray().Select(c => c.GetProperty("id").GetInt64()).SequenceEqual(expectedCategories))
                    throw new InvalidOperationException("Requested parameter definition or instance/type/category binding did not read back; roll back.");
                if (after.GetProperty("otherBindingsHash").GetString() != Hash(before)) throw new InvalidOperationException("Unrequested binding definition changed; roll back.");
                var values = after.GetProperty("owners").EnumerateArray().ToArray();
                if (values.Length != beforeValues.Length) throw new InvalidOperationException("Native bound-owner coverage changed; roll back.");
                for (var i = 0; i < values.Length; i++)
                {
                    var old = JsonSerializer.SerializeToElement(beforeValues[i]); var current = values[i];
                    if (old.GetProperty("id").GetInt64() != current.GetProperty("id").GetInt64() || old.GetProperty("uniqueId").GetString() != current.GetProperty("uniqueId").GetString()
                        || old.GetProperty("typeId").GetInt64() != current.GetProperty("typeId").GetInt64()
                        || old.GetProperty("categoryId").GetInt64() != current.GetProperty("categoryId").GetInt64()
                        || !current.GetProperty("hasParameter").GetBoolean() || current.GetProperty("parameterId").GetInt64() != id
                        || current.GetProperty("userModifiable").GetBoolean() != userModifiable)
                        throw new InvalidOperationException("A bound owner or parameter identity did not read back; roll back.");
                    if (old.GetProperty("hasParameter").GetBoolean() && (old.GetProperty("storage").GetRawText() != current.GetProperty("storage").GetRawText()
                        || old.GetProperty("hasValue").GetRawText() != current.GetProperty("hasValue").GetRawText() || old.GetProperty("value").GetRawText() != current.GetProperty("value").GetRawText()))
                        throw new InvalidOperationException("Pre-existing parameter data changed; roll back.");
                    if (!old.GetProperty("hasParameter").GetBoolean() && !IsEmptyDefault(current))
                        throw new InvalidOperationException("A new parameter contains an unexpected default value; roll back.");
                }
                return new Dictionary<string, object?> { ["parameter"] = after.GetProperty("parameter"), ["bindingReadback"] = after,
                    ["otherBindingsHashBefore"] = Hash(before), ["ownerValuesBefore"] = beforeValues,
                    ["requestedDefinition"] = new { name, guid = definition.GUID.ToString("D"), isInstance = instance, dataTypeId = dataType.TypeId,
                        groupTypeId = group.TypeId, visible, userModifiable, categories = categories.Select(c => new { id = ElementIdCompat.GetValue(c.Id), name = c.Name }).OrderBy(c => c.id).ToArray() },
                    ["existingParameterElementIdBefore"] = existingId };
            });
            result["status"] = OperatorNativeTransactionExecution.OutcomeStatus(result, "Success"); result["action"] = "create"; result["mode"] = "create_new";
            result["dryRun"] = false; result["externalDefinitionEffect"] = externalEffect();
            return result;
        }
        private static bool IsEmptyDefault(JsonElement owner)
        {
            var value = owner.GetProperty("value");
            if (!owner.GetProperty("hasValue").GetBoolean()) return value.ValueKind == JsonValueKind.Null;
            return owner.GetProperty("storage").GetString() == "String" ? value.ValueKind == JsonValueKind.String && value.GetString() == ""
                : value.ValueKind == JsonValueKind.Number && value.TryGetDouble(out var number) && number == 0;
        }
    }
}
