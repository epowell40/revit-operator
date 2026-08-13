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
            public long typeId { get; set; } // back-compat single target
            public List<long>? typeIds { get; set; } // optional multi-target
            public List<Change>? changes { get; set; }
            public bool dryRun { get; set; }
            public string? confirm { get; set; }
        }

        public Task<object> Handle(UIApplication app, string jsonData)
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

            using (var t = new Transaction(doc, "Set Type Parameters"))
            {
                t.Start();
                WarningSuppressionUtil.SuppressWarnings(t);

                foreach (var typeId in targetIds)
                {
                    var type = doc.GetElement(RevitBridge.Common.ElementIdCompat.Create(typeId)) as ElementType;
                    if (type == null)
                    {
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
                    foreach (var ch in changes)
                    {
                        var param = type.LookupParameter(ch.parameterName);
                        if (param == null)
                        {
                            diffs.Add(new { typeId = RevitBridge.Common.ElementIdCompat.GetValue(type.Id), parameterName = ch.parameterName, ok = false, changed = false, error = "Parameter not found on type." });
                            continue;
                        }

                        var before = ParameterValueUtil.SnapshotForWire(param);
                        var normalized = NormalizeInputForParam(doc, param, ch.value);
                        if (!ParameterValueUtil.TrySetFromString(param, normalized, out var didChange, out var message))
                        {
                            diffs.Add(new { typeId = RevitBridge.Common.ElementIdCompat.GetValue(type.Id), parameterName = ch.parameterName, ok = false, changed = false, error = message, before, after = before });
                            continue;
                        }

                        var after = ParameterValueUtil.SnapshotForWire(param);
                        if (didChange) changedCount++;
                        diffs.Add(new { typeId = RevitBridge.Common.ElementIdCompat.GetValue(type.Id), parameterName = ch.parameterName, ok = true, changed = didChange, before, after });
                    }

                    totalChangedCount += changedCount;
                    var result = new
                    {
                        typeId = RevitBridge.Common.ElementIdCompat.GetValue(type.Id),
                        typeName = type.Name,
                        ok = true,
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

                if (p.dryRun) t.RollBack();
                else t.Commit();
            }

            if (!p.dryRun && totalChangedCount > 0)
            {
                try { doc.Regenerate(); } catch { }
                try { uidoc.RefreshActiveView(); } catch { }
            }

            return Task.FromResult<object>(new
            {
                status = p.dryRun ? "Dry Run" : "Applied",
                dryRun = p.dryRun,
                typeCount = targetIds.Count,
                requestedCount,
                changedCount = totalChangedCount,
                results = perType,
                // Back-compat fields for single-target callers.
                typeId = targetIds.Count == 1 ? singleTypeId : null,
                typeName = targetIds.Count == 1 ? singleTypeName : null,
                diffs = targetIds.Count == 1 ? singleDiffs : null,
                requiredConfirm,
                confirmReceived
            });
        }

        private static string NormalizeInputForParam(Document doc, Parameter param, string raw)
        {
            if (param == null || param.StorageType != StorageType.Double) return raw ?? "";
            if (LengthTextUtil.TryParseLengthToFeet(doc, raw, out var ft, out _))
                return ft.ToString("G17", System.Globalization.CultureInfo.InvariantCulture);
            return raw ?? "";
        }
    }
}
