using System;
using System.Collections.Generic;
using System.Linq;
using System.Text.Json;
using System.Threading.Tasks;
using Autodesk.Revit.DB;
using Autodesk.Revit.UI;
using RevitBridge.Logic.Handlers.Core;
using RevitBridge.Common;

namespace RevitBridge.Logic.Handlers
{
    public class DuplicateTypeAndSwapInstanceHandler : IRequestHandler
    {
        public sealed class Change
        {
            public string parameterName { get; set; } = "";
            public string value { get; set; } = "";
        }

        public sealed class Params
        {
            public long instanceId { get; set; }
            public string newTypeName { get; set; } = "";
            public List<Change>? typeParamChanges { get; set; }
            public bool dryRun { get; set; } = true;
            public string? confirm { get; set; }
        }

        public Task<object> Handle(UIApplication app, string jsonData)
            => Task.FromResult(NativeMutationPreflightBoundary.Execute(enterNativeScope => HandleCore(app, jsonData, enterNativeScope)));

        private object HandleCore(UIApplication app, string jsonData, Action enterNativeScope)
        {
            var p = string.IsNullOrWhiteSpace(jsonData) ? new Params() : (JsonSerializer.Deserialize<Params>(jsonData) ?? new Params());
            if (p.instanceId <= 0) throw new ArgumentException("instanceId is required.");
            var newName = (p.newTypeName ?? "").Trim();
            if (newName.Length == 0) throw new ArgumentException("newTypeName is required.");

            var changes = (p.typeParamChanges ?? new List<Change>())
                .Where(x => x != null && !string.IsNullOrWhiteSpace(x.parameterName))
                .Select(x => new Change { parameterName = x.parameterName.Trim(), value = x.value ?? "" })
                .ToList();

            var confirmReceived = BulkConfirmUtil.Normalize(p.confirm);
            string? requiredConfirm = null;

            var uidoc = app.ActiveUIDocument;
            if (uidoc == null) throw new InvalidOperationException("No active UI document.");
            var doc = uidoc.Document;

            var inst = doc.GetElement(RevitBridge.Common.ElementIdCompat.Create(p.instanceId));
            if (inst == null) throw new InvalidOperationException($"Element {p.instanceId} not found.");

            var type = doc.GetElement(inst.GetTypeId()) as ElementType;
            if (type == null) throw new InvalidOperationException($"Element {p.instanceId} does not have a valid ElementType.");

            ElementType? created = null;
            var typeDiffs = new List<object>();
            long? swappedToTypeId = null;
            var missingAfter = new List<long>();
            var sourceTypeId = ElementIdCompat.GetValue(type.Id);
            var sourceTypeName = type.Name;
            var resultingInstanceId = p.instanceId;
            var deletedInstanceIds = new List<long>();
            var parameterFailures = 0;
            var expectedParameterValues = new Dictionary<string, string>();
            enterNativeScope();
            var result = NativeSingleTransaction.Execute(app, doc, "Duplicate Type and Swap Instance", nativeCreated =>
            {
                created = type.Duplicate(newName) as ElementType;
                if (created == null) throw new InvalidOperationException("Duplicate did not return an ElementType.");
                nativeCreated.Add(ElementIdCompat.GetValue(created.Id));

                foreach (var ch in changes)
                {
                    var param = created.LookupParameter(ch.parameterName);
                    if (param == null)
                    {
                        parameterFailures++;
                        typeDiffs.Add(new { typeId = RevitBridge.Common.ElementIdCompat.GetValue(created.Id), parameterName = ch.parameterName, ok = false, changed = false, error = "Parameter not found on type." });
                        continue;
                    }

                    var before = ParameterValueUtil.SnapshotForWire(param);
                    var normalized = NormalizeInputForParam(doc, param, ch.value);
                    if (!ParameterValueUtil.TrySetFromString(param, normalized, out var didChange, out var message))
                    {
                        parameterFailures++;
                        typeDiffs.Add(new { typeId = RevitBridge.Common.ElementIdCompat.GetValue(created.Id), parameterName = ch.parameterName, ok = false, changed = false, error = message, before, after = before });
                        continue;
                    }

                    var after = ParameterValueUtil.SnapshotForWire(param);
                    expectedParameterValues[ch.parameterName] = NativeParameterValue(param);
                    typeDiffs.Add(new { typeId = RevitBridge.Common.ElementIdCompat.GetValue(created.Id), parameterName = ch.parameterName, ok = true, changed = didChange, before, after });
                }

                try
                {
                    var replacementId = inst.ChangeTypeId(created.Id);
                    if (replacementId != ElementId.InvalidElementId)
                    {
                        resultingInstanceId = ElementIdCompat.GetValue(replacementId);
                        nativeCreated.Add(resultingInstanceId);
                        deletedInstanceIds.Add(p.instanceId);
                    }
                    swappedToTypeId = RevitBridge.Common.ElementIdCompat.GetValue(created.Id);
                }
                catch (Exception ex)
                {
                    throw new InvalidOperationException($"Failed to swap instance {p.instanceId} to new type: {ex.Message}");
                }

                return new Dictionary<string, object?>
                {
                    ["success"] = parameterFailures == 0, ["typeParameterChangesComplete"] = parameterFailures == 0,
                    ["dryRun"] = p.dryRun, ["instanceId"] = p.instanceId,
                    ["resultingInstanceId"] = resultingInstanceId, ["sourceTypeId"] = sourceTypeId,
                    ["sourceTypeName"] = sourceTypeName, ["newTypeName"] = newName,
                    ["newTypeId"] = p.dryRun ? (long?)null : swappedToTypeId, ["swappedToTypeId"] = swappedToTypeId,
                    ["requestedTypeParamChanges"] = changes.Count, ["typeParamDiffs"] = typeDiffs,
                    ["missingAfterElementIds"] = missingAfter, ["requiredConfirm"] = requiredConfirm,
                    ["confirmReceived"] = confirmReceived
                };
            }, nativeModifiedElements: () => resultingInstanceId == p.instanceId && swappedToTypeId.HasValue
                    ? new[] { p.instanceId } : Array.Empty<long>(),
                disposition: p.dryRun ? NativeTransactionDisposition.Rollback : NativeTransactionDisposition.Commit,
                nativeDeletedElements: () => deletedInstanceIds,
                configureTransaction: tx => WarningSuppressionUtil.SuppressWarnings(tx));
            if (!p.dryRun)
                OperatorNativeTransactionExecution.ReadCommitted(result, () =>
                {
                    var current = doc.GetElement(ElementIdCompat.Create(resultingInstanceId));
                    if (current == null) missingAfter.Add(resultingInstanceId);
                    if (current == null || ElementIdCompat.GetValue(current.GetTypeId()) != swappedToTypeId)
                        throw new InvalidOperationException("Committed instance type did not match the duplicated type.");
                    var persistedType = doc.GetElement(current.GetTypeId());
                    foreach (var expected in expectedParameterValues)
                    {
                        var parameter = persistedType?.LookupParameter(expected.Key)
                            ?? throw new InvalidOperationException("Committed type parameter is missing: " + expected.Key);
                        if (NativeParameterValue(parameter) != expected.Value)
                            throw new InvalidOperationException("Committed type parameter changed from its native result: " + expected.Key);
                    }
                    return new Dictionary<string, object?> { ["actualTypeId"] = ElementIdCompat.GetValue(current.GetTypeId()),
                        ["typeSwapVerified"] = true, ["successfulParameterReadbacksVerified"] = true };
                }, requestedChangesComplete: parameterFailures == 0);
            if (parameterFailures > 0) result["verified"] = false;
            result["status"] = OperatorNativeTransactionExecution.OutcomeStatus(result, "Applied");
            try { uidoc.RefreshActiveView(); } catch { }
            return result;
        }

        private static string NormalizeInputForParam(Document doc, Parameter param, string raw)
        {
            if (param == null || param.StorageType != StorageType.Double) return raw ?? "";
            if (LengthTextUtil.TryParseLengthToFeet(doc, raw, out var ft, out _))
                return ft.ToString("G17", System.Globalization.CultureInfo.InvariantCulture);
            return raw ?? "";
        }

        private static string NativeParameterValue(Parameter parameter) => parameter.StorageType switch
        {
            StorageType.String => "String:" + JsonSerializer.Serialize(parameter.AsString()),
            StorageType.Integer => "Integer:" + parameter.AsInteger().ToString(System.Globalization.CultureInfo.InvariantCulture),
            StorageType.Double => "Double:" + parameter.AsDouble().ToString("G17", System.Globalization.CultureInfo.InvariantCulture),
            StorageType.ElementId => "ElementId:" + ElementIdCompat.GetValue(parameter.AsElementId()).ToString(System.Globalization.CultureInfo.InvariantCulture),
            _ => throw new InvalidOperationException("Parameter has no readable native value.")
        };
    }
}
