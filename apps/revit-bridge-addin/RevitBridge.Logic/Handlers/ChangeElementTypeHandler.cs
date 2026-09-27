using System;
using System.Collections.Generic;
using System.Linq;
using System.Text.Json;
using System.Threading.Tasks;
using Autodesk.Revit.DB;
using Autodesk.Revit.UI;
using RevitBridge.Common;

namespace RevitBridge.Logic.Handlers
{
    public class ChangeElementTypeHandler : IRequestHandler
    {
        public class Params
        {
            public long? elementId { get; set; }
            public List<long>? elementIds { get; set; }
            public long? typeId { get; set; }
            public long? newTypeId { get; set; } // back-compat alias
            public string? typeName { get; set; } // optional: resolve by name
            public string? category { get; set; } // optional when resolving by name
            public string? familyName { get; set; } // optional when resolving by name
            public bool dryRun { get; set; }
            public bool cacheBust { get; set; }
            public int cacheMaxAgeSeconds { get; set; } = 180;
            public List<TypePrecondition>? expectedOldTypes { get; set; }
        }

        public class TypePrecondition
        {
            public long elementId { get; set; }
            public long typeId { get; set; }
        }

        public Task<object> Handle(UIApplication app, string jsonData)
            => Task.FromResult(NativeMutationPreflightBoundary.Execute(enterNativeScope =>
                HandleCore(app, jsonData, enterNativeScope).GetAwaiter().GetResult()));

        private Task<object> HandleCore(UIApplication app, string jsonData, Action enterNativeScope)
        {
            var p = string.IsNullOrEmpty(jsonData) ? new Params() : JsonSerializer.Deserialize<Params>(jsonData);
            if (p == null) throw new ArgumentException("Invalid JSON payload.");
            var ids = new List<long>();
            if (p.elementIds != null && p.elementIds.Count > 0)
            {
                ids.AddRange(p.elementIds.Where(x => x != 0));
            }
            else if (p.elementId.HasValue && p.elementId.Value != 0)
            {
                ids.Add(p.elementId.Value);
            }
            if (ids.Count == 0) throw new ArgumentException("Missing required parameter: elementId (or elementIds).");
            ids = ids.Distinct().ToList();

            var doc = app.ActiveUIDocument.Document;

            // Determine the new type id (either provided directly or resolved by name).
            var newTypeIdValue = (p.typeId ?? 0) != 0 ? p.typeId!.Value : (p.newTypeId ?? 0);
            ElementType? newType = null;

            if (newTypeIdValue != 0)
            {
                newType = doc.GetElement(RevitBridge.Common.ElementIdCompat.Create(newTypeIdValue)) as ElementType;
                if (newType == null) throw new ArgumentException($"Type {newTypeIdValue} not found or is not an ElementType.");
            }
            else
            {
                var tn = (p.typeName ?? "").Trim();
                if (tn.Length == 0) throw new ArgumentException("Missing required parameter: typeId (or newTypeId) or typeName.");

                // Category is optional: if omitted, infer from the first element's category when possible.
                var catRaw = (p.category ?? "").Trim();
                if (catRaw.Length == 0)
                {
                    var first = doc.GetElement(RevitBridge.Common.ElementIdCompat.Create(ids[0]));
                    var catId = RevitBridge.Common.ElementIdCompat.GetValue(first?.Category?.Id);
                    if (catId != 0 && catId >= int.MinValue && catId <= int.MaxValue)
                    {
                        var guess = (BuiltInCategory)(int)catId;
                        if (Enum.IsDefined(typeof(BuiltInCategory), guess))
                        {
                            catRaw = guess.ToString();
                        }
                    }
                }

                if (catRaw.Length == 0)
                    throw new ArgumentException("typeName requires category (e.g., 'OST_Walls') when element category cannot be inferred.");

                if (!ElementTypeResolver.TryResolveBuiltInCategory(catRaw, out var bic, out var canonical, out var suggestions))
                {
                    var hint = suggestions.Count > 0 ? $" Did you mean {string.Join(", ", suggestions.Take(5).Select(s => $"'{s}'"))}?" : " Use BuiltInCategory names like 'OST_Walls'.";
                    throw new ArgumentException($"Unknown BuiltInCategory '{catRaw}'.{hint}");
                }

                bool usedCache;
                var matches = ElementTypeResolver.SearchTypes(
                    doc,
                    bic,
                    tn,
                    familyName: p.familyName,
                    exact: true,
                    limit: 5,
                    cacheBust: p.cacheBust,
                    cacheMaxAgeSeconds: p.cacheMaxAgeSeconds,
                    usedCache: out usedCache
                );

                var chosen = matches.FirstOrDefault();
                if (chosen == null)
                {
                    // Provide some helpful near-matches.
                    bool usedCache2;
                    var near = ElementTypeResolver.SearchTypes(
                        doc,
                        bic,
                        tn,
                        familyName: p.familyName,
                        exact: false,
                        limit: 10,
                        cacheBust: false,
                        cacheMaxAgeSeconds: p.cacheMaxAgeSeconds,
                        usedCache: out usedCache2
                    );
                    var samples = near.Select(x => $"'{x.Name}'").Distinct().Take(6).ToList();
                    var suffix = samples.Count > 0 ? $" Examples: {string.Join(", ", samples)}" : "";
                    throw new ArgumentException($"No type found with name '{tn}' in category '{canonical}'.{suffix}");
                }

                newType = doc.GetElement(RevitBridge.Common.ElementIdCompat.Create(chosen.Id)) as ElementType;
                if (newType == null) throw new ArgumentException($"Resolved type {chosen.Id} not found or is not an ElementType.");
                newTypeIdValue = chosen.Id;
            }

            var changes = new List<object>();
            var expectedOldTypes = (p.expectedOldTypes ?? new List<TypePrecondition>())
                .Where(x => x.elementId > 0 && x.typeId > 0)
                .GroupBy(x => x.elementId)
                .ToDictionary(group => group.Key, group => group.Last().typeId);
            var conflictingGuardIds = (p.expectedOldTypes ?? new List<TypePrecondition>())
                .Where(x => x.elementId > 0 && x.typeId > 0)
                .GroupBy(x => x.elementId)
                .Where(group => group.Select(x => x.typeId).Distinct().Count() > 1)
                .Select(group => group.Key)
                .OrderBy(x => x)
                .ToList();
            var missingGuardIds = p.expectedOldTypes == null
                ? (p.dryRun ? new List<long>() : ids.OrderBy(id => id).ToList())
                : ids.Where(id => !expectedOldTypes.ContainsKey(id)).OrderBy(id => id).ToList();
            if (conflictingGuardIds.Count > 0 || missingGuardIds.Count > 0)
            {
                return Task.FromResult<object>(new
                {
                    ok = false,
                    dryRun = p.dryRun,
                    count = 0,
                    failureReason = "expectedOldTypes must contain exactly one unambiguous guard for every target element.",
                    conflictingGuardIds,
                    missingGuardIds,
                    changedElementIds = new List<long>(),
                    transaction = OperatorNativeTransactionReceipt.NotStarted(),
                    changes
                });
            }

            // Dry-run: validate only.
            if (p.dryRun)
            {
                var dryRunOk = true;
                foreach (var id in ids)
                {
                    var elem = doc.GetElement(RevitBridge.Common.ElementIdCompat.Create(id));
                    if (elem == null)
                    {
                        dryRunOk = false;
                        changes.Add(new { elementId = id, ok = false, error = "Element not found" });
                        continue;
                    }
                    var oldTypeId = elem.GetTypeId();
                    var oldTypeIdValue = RevitBridge.Common.ElementIdCompat.GetValue(oldTypeId);
                    var preconditionMatched = !expectedOldTypes.TryGetValue(id, out var expectedOldTypeId)
                        || expectedOldTypeId == oldTypeIdValue;
                    if (!preconditionMatched) dryRunOk = false;
                    changes.Add(new
                    {
                        elementId = id,
                        ok = preconditionMatched,
                        dryRun = true,
                        oldTypeId = oldTypeIdValue,
                        newTypeId = newTypeIdValue,
                        preconditionMatched,
                        expectedOldTypeId = expectedOldTypes.TryGetValue(id, out var expected) ? expected : (long?)null,
                        error = preconditionMatched ? null : "Current type no longer matches expectedOldTypes."
                    });
                }

                return Task.FromResult<object>(new { ok = dryRunOk, dryRun = true, changes,
                    transaction = OperatorNativeTransactionReceipt.NotStarted() });
            }

            var targets = new List<(long Id, Element Element, long OldTypeId, string? OldTypeName)>();
            foreach (var id in ids)
            {
                var element = doc.GetElement(ElementIdCompat.Create(id));
                if (element == null)
                {
                    changes.Add(new { elementId = id, ok = false, error = "Element not found" });
                    continue;
                }
                var oldTypeId = ElementIdCompat.GetValue(element.GetTypeId());
                if (!expectedOldTypes.TryGetValue(id, out var expected) || expected != oldTypeId)
                {
                    changes.Add(new { elementId = id, ok = false, error = "Current type no longer matches expectedOldTypes.",
                        oldTypeId, expectedOldTypeId = expected, newTypeId = newTypeIdValue });
                    continue;
                }
                targets.Add((id, element, oldTypeId, doc.GetElement(element.GetTypeId())?.Name));
            }
            if (changes.Count > 0 || targets.Count != ids.Count)
                return Task.FromResult<object>(new
                {
                    ok = false, count = 0, changedElementIds = new List<long>(), changes,
                    failureReason = "Type-change preconditions failed before any element was changed.",
                    transaction = OperatorNativeTransactionReceipt.NotStarted()
                });

            var requestedTypeId = newType!.Id;
            var requestedTypeName = newType.Name;
            var resultingIds = new Dictionary<long, long>();
            var modifiedIds = new HashSet<long>();
            var deletedIds = new HashSet<long>();
            enterNativeScope();
            var result = NativeSingleTransaction.Execute(app, doc, "Change Element Type", nativeCreated =>
            {
                foreach (var target in targets)
                {
                    if (ElementIdCompat.GetValue(target.Element.GetTypeId()) != target.OldTypeId)
                        throw new InvalidOperationException("Type-change precondition changed before mutation.");
                    var replacement = target.Element.ChangeTypeId(requestedTypeId);
                    var resultingId = target.Id;
                    if (replacement != ElementId.InvalidElementId)
                    {
                        resultingId = ElementIdCompat.GetValue(replacement);
                        nativeCreated.Add(resultingId);
                        deletedIds.Add(target.Id);
                    }
                    else if (target.OldTypeId != newTypeIdValue) modifiedIds.Add(target.Id);
                    resultingIds[target.Id] = resultingId;
                    changes.Add(new { elementId = target.Id, resultingElementId = resultingId, ok = true,
                        oldTypeId = target.OldTypeId, oldTypeName = target.OldTypeName,
                        newTypeId = newTypeIdValue, newTypeName = requestedTypeName });
                }
                doc.Regenerate();
                foreach (var id in resultingIds.Values)
                {
                    var current = doc.GetElement(ElementIdCompat.Create(id));
                    if (current == null || ElementIdCompat.GetValue(current.GetTypeId()) != newTypeIdValue)
                        throw new InvalidOperationException("Type-change readback failed; the complete batch must roll back.");
                }
                return new Dictionary<string, object?>
                {
                    ["count"] = targets.Count, ["newTypeId"] = newTypeIdValue, ["newTypeName"] = requestedTypeName,
                    ["changedElementIds"] = resultingIds.Values.Distinct().OrderBy(id => id).ToList(), ["changes"] = changes
                };
            }, nativeModifiedElements: () => modifiedIds, nativeDeletedElements: () => deletedIds);
            OperatorNativeTransactionExecution.ReadCommitted(result, () =>
            {
                var readback = resultingIds.Select(pair =>
                {
                    var current = doc.GetElement(ElementIdCompat.Create(pair.Value));
                    return new { elementId = pair.Key, resultingElementId = pair.Value,
                        actualTypeId = current == null ? 0 : ElementIdCompat.GetValue(current.GetTypeId()),
                        expectedTypeId = newTypeIdValue };
                }).ToList();
                if (readback.Any(row => row.actualTypeId != row.expectedTypeId))
                    throw new InvalidOperationException("Committed type-change readback did not match the requested type.");
                return new Dictionary<string, object?> { ["readback"] = readback };
            });
            var receipt = (OperatorNativeTransactionReceipt)result["transaction"]!;
            result["committed"] = receipt.CommittedValue;
            result["status"] = OperatorNativeTransactionExecution.OutcomeStatus(result, "Applied");
            result["rolledBack"] = receipt.Status == "rolled_back";
            if (receipt.CommittedValue != true)
            {
                result["count"] = 0;
                result["changedElementIds"] = new List<long>();
            }
            try { app.ActiveUIDocument?.RefreshActiveView(); } catch { }
            return Task.FromResult<object>(result);
        }
    }
}
