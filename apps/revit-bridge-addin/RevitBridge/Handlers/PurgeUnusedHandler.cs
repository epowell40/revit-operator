using System;
using System.Collections.Generic;
using System.Linq;
using System.Reflection;
using System.Text.Json;
using System.Threading.Tasks;
using Autodesk.Revit.DB;
using Autodesk.Revit.UI;
using RevitBridge.Common;

namespace RevitBridge.Handlers
{
    public sealed class PurgeUnusedHandler : IRequestHandler
    {
        public sealed class Params
        {
            public string? action { get; set; } // analyze (default) | purge
            public int? maxPreview { get; set; } // default 100
            public int? maxDelete { get; set; } // default 5000
            public bool? dryRun { get; set; } // purge
            public bool? apply { get; set; } // purge
            // Accept string + compatibility tokens (bool/number), coerced at runtime.
            public object? confirm { get; set; } // purge bulk confirmation
        }

        public Task<object> Handle(UIApplication app, string jsonData)
        {
            var p = string.IsNullOrWhiteSpace(jsonData)
                ? new Params()
                : (JsonSerializer.Deserialize<Params>(jsonData) ?? new Params());

            var doc = app.ActiveUIDocument?.Document;
            if (doc == null) throw new InvalidOperationException("No active Revit document.");

            var action = NormalizeAction(p.action);
            var maxPreview = p.maxPreview.GetValueOrDefault(100);
            if (maxPreview < 0) maxPreview = 0;
            if (maxPreview > 1000) maxPreview = 1000;

            var allUnusedIds = GetUnusedIds(doc);
            var preview = allUnusedIds
                .Take(maxPreview)
                .Select(id => DescribeElement(doc, id))
                .ToList();

            if (action == "analyze")
            {
                return Task.FromResult<object>(new
                {
                    status = "Ok",
                    action = "analyze",
                    unusedCount = allUnusedIds.Count,
                    previewCount = preview.Count,
                    preview
                });
            }

            if (action != "purge")
                throw new InvalidOperationException("purge-unused.action must be analyze or purge.");

            var maxDelete = p.maxDelete.GetValueOrDefault(5000);
            if (maxDelete < 1) maxDelete = 1;
            if (maxDelete > 20000) maxDelete = 20000;

            var targets = allUnusedIds.Take(maxDelete).Select(x => RevitBridge.Common.ElementIdCompat.Create(x)).ToList();
            var requestedCount = targets.Count;

            var explicitlyApply = p.apply.HasValue && p.apply.Value;
            var isDryRun = (p.dryRun ?? !explicitlyApply) || (p.apply.HasValue && p.apply.Value == false);
            var apply = !isDryRun;
            var confirmText = CoerceConfirmText(p.confirm);

            string? requiredConfirm = null;
            var confirmReceived = BulkConfirmUtil.Normalize(confirmText);
            if (apply && requestedCount > 25)
            {
                requiredConfirm = BulkConfirmUtil.ExpectedDeleteElements(requestedCount);
                if (!BulkConfirmUtil.EqualsNormalized(confirmText, requiredConfirm))
                {
                    throw new OperatorToolUserErrorException(
                        message: "Bulk purge requires typed confirmation.",
                        code: "bulk_confirm_required",
                        requiredConfirm: requiredConfirm,
                        confirmReceived: confirmReceived,
                        maxChangesPerCall: 10,
                        hint: "Retry with confirm set to the requiredConfirm string (exact, but markdown like **...** is ok). If OPERATOR_BULK_CONFIRM_SIMPLE=1, you can also use confirm:\"yes\".");
                }
            }

            if (requestedCount == 0)
            {
                return Task.FromResult<object>(new
                {
                    status = "NoOp",
                    action = "purge",
                    dryRun = isDryRun,
                    requestedCount = 0,
                    impactedCount = 0,
                    message = "No purgeable unused elements were found."
                });
            }

            using (var tx = new Transaction(doc, "Purge Unused (Operator)"))
            {
                tx.Start();
                ICollection<ElementId>? deleted = null;
                try
                {
                    deleted = doc.Delete(targets);
                }
                catch
                {
                    tx.RollBack();
                    throw;
                }

                var impactedIds = (deleted ?? Array.Empty<ElementId>())
                    .Select(x => RevitBridge.Common.ElementIdCompat.GetValue(x))
                    .Distinct()
                    .OrderBy(x => x)
                    .ToList();

                if (apply) tx.Commit();
                else tx.RollBack();

                return Task.FromResult<object>(new
                {
                    status = apply ? "Purged" : "Dry Run",
                    action = "purge",
                    dryRun = !apply,
                    requestedCount,
                    impactedCount = impactedIds.Count,
                    sampledRequestedIds = targets.Take(100).Select(x => RevitBridge.Common.ElementIdCompat.GetValue(x)).ToList(),
                    sampledImpactedIds = impactedIds.Take(100).ToList(),
                    requiredConfirm,
                    confirmReceived
                });
            }
        }

        private static List<long> GetUnusedIds(Document doc)
        {
            var empty = new HashSet<ElementId>();
            var method = typeof(Document).GetMethod("GetAllUnusedElements", BindingFlags.Instance | BindingFlags.Public, null, new[] { typeof(ISet<ElementId>) }, null)
                ?? typeof(Document).GetMethod("GetAllUnusedElements", BindingFlags.Instance | BindingFlags.Public, null, new[] { typeof(ICollection<ElementId>) }, null);

            if (method == null)
            {
                return new List<long>();
            }

            var raw = method.GetParameters().Length == 1
                ? method.Invoke(doc, new object[] { empty })
                : null;
            if (raw is not IEnumerable<ElementId> ids)
            {
                return new List<long>();
            }

            return ids
                .Where(x => x != null && RevitBridge.Common.ElementIdCompat.GetValue(x) > 0)
                .Select(x => RevitBridge.Common.ElementIdCompat.GetValue(x))
                .Distinct()
                .OrderBy(x => x)
                .ToList();
        }

        private static object DescribeElement(Document doc, long idValue)
        {
            var id = RevitBridge.Common.ElementIdCompat.Create(idValue);
            var e = doc.GetElement(id);
            return new
            {
                elementId = idValue,
                exists = e != null,
                category = e?.Category?.Name,
                name = e?.Name,
                className = e?.GetType().Name,
                isType = e is ElementType
            };
        }

        private static string NormalizeAction(string? action)
        {
            var value = (action ?? "analyze").Trim().ToLowerInvariant();
            return value switch
            {
                "analyze" => "analyze",
                "list" => "analyze",
                "purge" => "purge",
                _ => value
            };
        }

        private static string? CoerceConfirmText(object? raw)
        {
            if (raw == null) return null;
            if (raw is string s) return s;
            if (raw is bool b) return b ? "yes" : "";
            if (raw is int i) return i.ToString(System.Globalization.CultureInfo.InvariantCulture);
            if (raw is long l) return l.ToString(System.Globalization.CultureInfo.InvariantCulture);
            if (raw is double d) return d.ToString(System.Globalization.CultureInfo.InvariantCulture);

            if (raw is JsonElement je)
            {
                switch (je.ValueKind)
                {
                    case JsonValueKind.String:
                        return je.GetString();
                    case JsonValueKind.True:
                        return "yes";
                    case JsonValueKind.False:
                        return "";
                    case JsonValueKind.Number:
                        return je.GetRawText();
                    case JsonValueKind.Null:
                    case JsonValueKind.Undefined:
                        return null;
                }
            }

            return raw.ToString();
        }
    }
}
