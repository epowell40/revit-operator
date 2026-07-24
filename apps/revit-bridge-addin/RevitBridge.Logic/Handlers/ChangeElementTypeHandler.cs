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

                return Task.FromResult<object>(new { ok = dryRunOk, dryRun = true, changes });
            }

            using (var t = new Transaction(doc, "Change Element Type"))
            {
                try
                {
                    var startStatus = t.Start();
                    if (startStatus != TransactionStatus.Started)
                    {
                        return Task.FromResult<object>(new
                        {
                            ok = false,
                            count = 0,
                            rolledBack = false,
                            failureReason = "Revit did not start the type-change transaction.",
                            transactionStartStatus = startStatus.ToString(),
                            changedElementIds = new List<long>()
                        });
                    }
                }
                catch (Exception ex)
                {
                    return Task.FromResult<object>(new
                    {
                        ok = false,
                        count = 0,
                        rolledBack = false,
                        failureReason = "Revit could not start the type-change transaction.",
                        error = ex.Message,
                        changedElementIds = new List<long>()
                    });
                }
                var targets = new List<(long Id, Element Element, long OldTypeId, string? OldTypeName)>();
                foreach (var id in ids)
                {
                    var elem = doc.GetElement(RevitBridge.Common.ElementIdCompat.Create(id));
                    if (elem == null)
                    {
                        changes.Add(new { elementId = id, ok = false, error = "Element not found" });
                        continue;
                    }

                    var oldTypeId = elem.GetTypeId();
                    var oldType = doc.GetElement(oldTypeId) as ElementType;
                    var oldTypeIdValue = RevitBridge.Common.ElementIdCompat.GetValue(oldTypeId);
                    if (expectedOldTypes.TryGetValue(id, out var expectedOldTypeId) && expectedOldTypeId != oldTypeIdValue)
                    {
                        changes.Add(new
                        {
                            elementId = id,
                            ok = false,
                            error = "Current type no longer matches expectedOldTypes.",
                            oldTypeId = oldTypeIdValue,
                            expectedOldTypeId,
                            newTypeId = newTypeIdValue
                        });
                        continue;
                    }
                    targets.Add((id, elem, oldTypeIdValue, oldType?.Name));
                }

                if (changes.Count > 0 || targets.Count != ids.Count)
                {
                    var rolledBack = RollBackTransaction(t);
                    return Task.FromResult<object>(new
                    {
                        ok = false,
                        count = 0,
                        rolledBack,
                        failureReason = "Type-change preconditions failed before any element was changed.",
                        changedElementIds = new List<long>(),
                        changes
                    });
                }

                var attemptedChanges = new List<object>();
                try
                {
                    foreach (var target in targets)
                    {
                        target.Element.ChangeTypeId(newType!.Id);
                        attemptedChanges.Add(new
                        {
                            elementId = target.Id,
                            ok = true,
                            oldTypeId = target.OldTypeId,
                            oldTypeName = target.OldTypeName,
                            newTypeId = RevitBridge.Common.ElementIdCompat.GetValue(newType.Id),
                            newTypeName = newType.Name
                        });
                    }
                    doc.Regenerate();
                }
                catch (Exception ex)
                {
                    var rolledBack = RollBackTransaction(t);
                    return Task.FromResult<object>(new
                    {
                        ok = false,
                        count = 0,
                        rolledBack,
                        failureReason = "A type change failed; the complete batch was rolled back.",
                        error = ex.Message,
                        changedElementIds = new List<long>(),
                        attemptedChanges
                    });
                }

                var newTypeIdActual = RevitBridge.Common.ElementIdCompat.GetValue(newType!.Id);
                var preCommitReadback = targets.Select(target => new
                {
                    elementId = target.Id,
                    actualTypeId = RevitBridge.Common.ElementIdCompat.GetValue(target.Element.GetTypeId()),
                    expectedTypeId = newTypeIdActual
                }).ToList();
                var mismatches = preCommitReadback.Where(row => row.actualTypeId != row.expectedTypeId).ToList();
                if (mismatches.Count > 0)
                {
                    var rolledBack = RollBackTransaction(t);
                    return Task.FromResult<object>(new
                    {
                        ok = false,
                        count = 0,
                        rolledBack,
                        failureReason = "Type-change readback failed; the complete batch was rolled back.",
                        changedElementIds = new List<long>(),
                        readback = preCommitReadback,
                        mismatches,
                        attemptedChanges
                    });
                }

                try
                {
                    var commitStatus = t.Commit();
                    if (commitStatus != TransactionStatus.Committed)
                    {
                        var rolledBack = EnsureRolledBack(t, commitStatus);
                        return Task.FromResult<object>(new
                        {
                            ok = false,
                            count = 0,
                            rolledBack,
                            failureReason = "Revit did not commit the complete type-change batch.",
                            transactionCommitStatus = commitStatus.ToString(),
                            changedElementIds = new List<long>(),
                            attemptedChanges
                        });
                    }
                }
                catch (Exception ex)
                {
                    var rolledBack = RollBackTransaction(t);
                    return Task.FromResult<object>(new
                    {
                        ok = false,
                        count = 0,
                        rolledBack,
                        failureReason = "Revit could not commit the type-change batch.",
                        error = ex.Message,
                        changedElementIds = new List<long>(),
                        attemptedChanges
                    });
                }

                changes.AddRange(attemptedChanges);
                try { app.ActiveUIDocument?.RefreshActiveView(); } catch { }

                var readback = targets.Select(target =>
                {
                    var current = doc.GetElement(ElementIdCompat.Create(target.Id));
                    return new
                    {
                        elementId = target.Id,
                        actualTypeId = current == null ? 0 : ElementIdCompat.GetValue(current.GetTypeId()),
                        expectedTypeId = newTypeIdActual
                    };
                }).ToList();
                var postCommitMismatches = readback.Where(row => row.actualTypeId != row.expectedTypeId).ToList();
                if (postCommitMismatches.Count > 0)
                {
                    return Task.FromResult<object>(new
                    {
                        ok = false,
                        count = targets.Count,
                        committed = true,
                        rolledBack = false,
                        failureReason = "Committed type-change readback did not match the requested type.",
                        newTypeId = newTypeIdActual,
                        changedElementIds = targets.Select(target => target.Id).OrderBy(x => x).ToList(),
                        readback,
                        mismatches = postCommitMismatches,
                        changes
                    });
                }

                return Task.FromResult<object>(new
                {
                    ok = true,
                    count = targets.Count,
                    committed = true,
                    rolledBack = false,
                    newTypeId = newTypeIdActual,
                    newTypeName = newType!.Name,
                    changedElementIds = targets.Select(target => target.Id).OrderBy(x => x).ToList(),
                    readback,
                    changes
                });
            }
        }

        private static bool RollBackTransaction(Transaction transaction)
        {
            try { return transaction.RollBack() == TransactionStatus.RolledBack; }
            catch { return false; }
        }

        private static bool EnsureRolledBack(Transaction transaction, TransactionStatus knownStatus)
        {
            if (knownStatus == TransactionStatus.RolledBack) return true;
            try
            {
                if (transaction.GetStatus() == TransactionStatus.RolledBack) return true;
            }
            catch { }
            return RollBackTransaction(transaction);
        }
    }
}
