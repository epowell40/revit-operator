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

            // Dry-run: validate only.
            if (p.dryRun)
            {
                foreach (var id in ids)
                {
                    var elem = doc.GetElement(RevitBridge.Common.ElementIdCompat.Create(id));
                    if (elem == null)
                    {
                        changes.Add(new { elementId = id, ok = false, error = "Element not found" });
                        continue;
                    }
                    var oldTypeId = elem.GetTypeId();
                    changes.Add(new
                    {
                        elementId = id,
                        ok = true,
                        dryRun = true,
                        oldTypeId = RevitBridge.Common.ElementIdCompat.GetValue(oldTypeId),
                        newTypeId = newTypeIdValue
                    });
                }

                return Task.FromResult<object>(new { ok = true, dryRun = true, changes });
            }

            using (var t = new Transaction(doc, "Change Element Type"))
            {
                t.Start();
                var successCount = 0;
                var changedElementIds = new HashSet<long>();
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

                    try
                    {
                        elem.ChangeTypeId(newType!.Id);
                        successCount++;
                        changedElementIds.Add(id);
                        changes.Add(new
                        {
                            elementId = id,
                            ok = true,
                            oldTypeId = RevitBridge.Common.ElementIdCompat.GetValue(oldTypeId),
                            oldTypeName = oldType?.Name,
                            newTypeId = RevitBridge.Common.ElementIdCompat.GetValue(newType!.Id),
                            newTypeName = newType!.Name
                        });
                    }
                    catch (Exception ex)
                    {
                        changes.Add(new { elementId = id, ok = false, error = ex.Message, oldTypeId = RevitBridge.Common.ElementIdCompat.GetValue(oldTypeId), newTypeId = newTypeIdValue });
                    }
                }
                t.Commit();

                try { doc.Regenerate(); } catch { }
                try { app.ActiveUIDocument?.RefreshActiveView(); } catch { }

                List<long>? missingAfterElementIds = null;
                try
                {
                    missingAfterElementIds = changedElementIds
                        .Where(x => doc.GetElement(RevitBridge.Common.ElementIdCompat.Create(x)) == null)
                        .OrderBy(x => x)
                        .ToList();
                }
                catch
                {
                    missingAfterElementIds = null;
                }

                return Task.FromResult<object>(new
                {
                    ok = true,
                    count = successCount,
                    newTypeId = RevitBridge.Common.ElementIdCompat.GetValue(newType!.Id),
                    newTypeName = newType!.Name,
                    changedElementIds = changedElementIds.OrderBy(x => x).ToList(),
                    missingAfterElementIds,
                    changes
                });
            }
        }
    }
}
