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
    public class SetTypeParametersHandler : IRequestHandler
    {
        public sealed class Change
        {
            public string parameterName { get; set; } = "";
            public string value { get; set; } = "";
        }

        public sealed class Params
        {
            [System.ComponentModel.DefaultValue(0L)]
            public long typeId { get; set; } // omitted when typeIds supplies the targets
            public List<long>? typeIds { get; set; } // optional multi-target
            public List<Change>? changes { get; set; }
            public bool dryRun { get; set; }
            public string? confirm { get; set; }
        }

        public Task<object> Handle(UIApplication app, string jsonData)
            => Task.FromResult(NativeMutationPreflightBoundary.Execute(enterNativeScope => HandleCore(app, jsonData, enterNativeScope)));

        private object HandleCore(UIApplication app, string jsonData, Action enterNativeScope)
        {
            var p = string.IsNullOrWhiteSpace(jsonData) ? new Params() : (JsonSerializer.Deserialize<Params>(jsonData) ?? new Params());

            var targetIds = new List<long>();
            if (p.typeIds != null)
            {
                targetIds.AddRange(p.typeIds.Where(x => x > 0));
            }
            if (targetIds.Count == 0 && p.typeId > 0)
            {
                targetIds.Add(p.typeId);
            }
            targetIds = targetIds.Distinct().ToList();

            if (targetIds.Count == 0) throw new ArgumentException("typeId or typeIds is required.");

            var changes = (p.changes ?? new List<Change>())
                .Where(x => x != null && !string.IsNullOrWhiteSpace(x.parameterName))
                .Select(x => new Change { parameterName = x.parameterName.Trim(), value = x.value ?? "" })
                .ToList();

            if (changes.Count == 0) throw new InvalidOperationException("changes is required and must be a non-empty array.");

            var confirmReceived = BulkConfirmUtil.Normalize(p.confirm);
            string? requiredConfirm = null;
            var requestedCount = changes.Count * targetIds.Count;

            var uidoc = app.ActiveUIDocument;
            if (uidoc == null) throw new InvalidOperationException("No active UI document.");
            var doc = uidoc.Document;

            var perType = new List<object>();
            var totalChangedCount = 0;
            long? singleTypeId = null;
            string? singleTypeName = null;
            object? singleDiffs = null;
            var changedTypeIds = new HashSet<long>();
            var parameterFailures = 0;
            var expectedParameterValues = new Dictionary<(long TypeId, string Name), string>();
            enterNativeScope();
            var response = NativeSingleTransaction.Execute(app, doc, "Set Type Parameters", _ =>
            {
                foreach (var typeId in targetIds)
                {
                    var type = doc.GetElement(RevitBridge.Common.ElementIdCompat.Create(typeId)) as ElementType;
                    if (type == null)
                    {
                        parameterFailures += changes.Count;
                        var item = new
                        {
                            typeId,
                            ok = false,
                            error = $"Element {typeId} not found or is not an ElementType.",
                            requestedCount = changes.Count,
                            changedCount = 0,
                            diffs = new List<object>()
                        };
                        perType.Add(item);
                        if (targetIds.Count == 1)
                        {
                            singleTypeId = typeId;
                            singleTypeName = null;
                            singleDiffs = item.diffs;
                        }
                        continue;
                    }

                    var diffs = new List<object>();
                    var changedCount = 0;
                    var failuresBeforeType = parameterFailures;
                    foreach (var ch in changes)
                    {
                        var param = type.LookupParameter(ch.parameterName);
                        if (param == null)
                        {
                            parameterFailures++;
                            diffs.Add(new { typeId = RevitBridge.Common.ElementIdCompat.GetValue(type.Id), parameterName = ch.parameterName, ok = false, changed = false, error = "Parameter not found on type." });
                            continue;
                        }

                        var before = ParameterValueUtil.SnapshotForWire(param);
                        var normalized = NormalizeInputForParam(doc, param, ch.value);
                        if (!ParameterValueUtil.TrySetFromString(param, normalized, out var didChange, out var message))
                        {
                            parameterFailures++;
                            diffs.Add(new { typeId = RevitBridge.Common.ElementIdCompat.GetValue(type.Id), parameterName = ch.parameterName, ok = false, changed = false, error = message, before, after = before });
                            continue;
                        }

                        var after = ParameterValueUtil.SnapshotForWire(param);
                        expectedParameterValues[(typeId, ch.parameterName)] = NativeParameterValue(param);
                        if (didChange) changedCount++;
                        diffs.Add(new { typeId = RevitBridge.Common.ElementIdCompat.GetValue(type.Id), parameterName = ch.parameterName, ok = true, changed = didChange, before, after });
                    }

                    totalChangedCount += changedCount;
                    if (changedCount > 0) changedTypeIds.Add(typeId);
                    var result = new
                    {
                        typeId = RevitBridge.Common.ElementIdCompat.GetValue(type.Id),
                        typeName = type.Name,
                        ok = parameterFailures == failuresBeforeType,
                        requestedCount = changes.Count,
                        changedCount,
                        diffs
                    };
                    perType.Add(result);
                    if (targetIds.Count == 1)
                    {
                        singleTypeId = result.typeId;
                        singleTypeName = result.typeName;
                        singleDiffs = result.diffs;
                    }
                }

                return new Dictionary<string, object?>
                {
                    ["success"] = parameterFailures == 0, ["parameterChangesComplete"] = parameterFailures == 0,
                    ["dryRun"] = p.dryRun, ["typeCount"] = targetIds.Count,
                    ["requestedCount"] = requestedCount, ["changedCount"] = totalChangedCount,
                    ["results"] = perType, ["typeId"] = targetIds.Count == 1 ? singleTypeId : null,
                    ["typeName"] = targetIds.Count == 1 ? singleTypeName : null,
                    ["diffs"] = targetIds.Count == 1 ? singleDiffs : null,
                    ["requiredConfirm"] = requiredConfirm, ["confirmReceived"] = confirmReceived
                };
            }, nativeModifiedElements: () => changedTypeIds,
                disposition: p.dryRun ? NativeTransactionDisposition.Rollback : NativeTransactionDisposition.Commit,
                configureTransaction: tx => WarningSuppressionUtil.SuppressWarnings(tx));
            if (!p.dryRun)
                OperatorNativeTransactionExecution.ReadCommitted(response, () =>
                {
                    foreach (var expected in expectedParameterValues)
                    {
                        var parameter = doc.GetElement(ElementIdCompat.Create(expected.Key.TypeId))?.LookupParameter(expected.Key.Name)
                            ?? throw new InvalidOperationException("Committed type parameter is missing: " + expected.Key.Name);
                        if (NativeParameterValue(parameter) != expected.Value)
                            throw new InvalidOperationException("Committed type parameter changed from its native result: " + expected.Key.Name);
                    }
                    return new Dictionary<string, object?> { ["successfulParameterReadbacksVerified"] = true };
                }, requestedChangesComplete: parameterFailures == 0);
            if (parameterFailures > 0) response["verified"] = false;
            response["status"] = OperatorNativeTransactionExecution.OutcomeStatus(response, "Applied");
            response["applied"] = ((OperatorNativeTransactionReceipt)response["transaction"]!).CommittedValue;
            if (!p.dryRun && totalChangedCount > 0) { try { uidoc.RefreshActiveView(); } catch { } }
            return response;
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
