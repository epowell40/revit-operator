using System;
using System.Collections.Generic;
using System.Linq;
using System.Text.Json;
using System.Threading.Tasks;
using Autodesk.Revit.DB;
using Autodesk.Revit.UI;
using RevitBridge.Common;

namespace RevitBridge.Logic.Handlers.Drafting
{
    public sealed class CreateDraftingViewHandler : IRequestHandler
    {
        public sealed class Params
        {
            public string? name { get; set; }
            public int? scale { get; set; }
            public bool? allowExisting { get; set; }
        }

        public Task<object> Handle(UIApplication app, string jsonData)
        {
            var p = string.IsNullOrWhiteSpace(jsonData) ? new Params() : (JsonSerializer.Deserialize<Params>(jsonData) ?? new Params());
            var doc = app.ActiveUIDocument.Document;

            var name = (p.name ?? "").Trim();
            if (string.IsNullOrWhiteSpace(name)) throw new InvalidOperationException("create-drafting-view.name is required.");
            if (name.Length > 120) name = name.Substring(0, 120).Trim();

            var allowExisting = p.allowExisting ?? true;

            ElementId? outputId = null;
            var modified = new HashSet<long>();
            var result = NativeSingleTransaction.Execute(app, doc, "Create Drafting View", nativeCreated =>
            {
                if (allowExisting)
                {
                    var existing = new FilteredElementCollector(doc)
                        .OfClass(typeof(ViewDrafting))
                        .Cast<ViewDrafting>()
                        .FirstOrDefault(v => v != null && !v.IsTemplate && string.Equals(v.Name, name, StringComparison.OrdinalIgnoreCase));

                    if (existing != null)
                    {
                        var previousScale = existing.Scale;
                        TrySetScale(existing, p.scale);
                        if (existing.Scale != previousScale) modified.Add(ElementIdCompat.GetValue(existing.Id));
                        outputId = existing.Id;
                        return new Dictionary<string, object?> { ["created"] = false };
                    }
                }

                var vft = new FilteredElementCollector(doc)
                    .OfClass(typeof(ViewFamilyType))
                    .Cast<ViewFamilyType>()
                    .FirstOrDefault(x => x.ViewFamily == ViewFamily.Drafting);
                if (vft == null) throw new InvalidOperationException("No ViewFamilyType for Drafting views found.");

                var dv = ViewDrafting.Create(doc, vft.Id);
                dv.Name = EnsureUniqueViewName(doc, name);
                TrySetScale(dv, p.scale);

                outputId = dv.Id;
                nativeCreated.Add(ElementIdCompat.GetValue(dv.Id));
                return new Dictionary<string, object?> { ["created"] = true };
            }, () => modified);
            return Task.FromResult<object>(OperatorNativeTransactionExecution.ReadCommitted(result, () =>
            {
                var view = outputId == null ? null : doc.GetElement(outputId) as ViewDrafting;
                if (view == null) throw new InvalidOperationException("Committed drafting view was not found during readback.");
                if (p.scale.HasValue && view.Scale != p.scale.Value)
                    throw new InvalidOperationException("Drafting view committed, but its actual scale does not match the requested scale.");
                return new Dictionary<string, object?>
                {
                    ["status"] = "Success", ["viewId"] = ElementIdCompat.GetValue(view.Id),
                    ["name"] = view.Name, ["scale"] = view.Scale, ["viewType"] = view.ViewType.ToString()
                };
            }));
        }

        private static void TrySetScale(View view, int? scale)
        {
            try
            {
                if (!scale.HasValue) return;
                var s = scale.Value;
                if (s < 1 || s > 2400) return;
                view.Scale = s;
            }
            catch
            {
                // ignore (some views may not allow scale set)
            }
        }

        private static string EnsureUniqueViewName(Document doc, string name)
        {
            var existing = new FilteredElementCollector(doc)
                .OfClass(typeof(View))
                .Cast<View>()
                .Where(v => v != null && !v.IsTemplate)
                .Select(v => v.Name ?? "")
                .ToHashSet(StringComparer.OrdinalIgnoreCase);

            if (!existing.Contains(name)) return name;
            for (int i = 2; i <= 50; i++)
            {
                var cand = $"{name} ({i})";
                if (!existing.Contains(cand)) return cand;
            }
            return $"{name} ({Guid.NewGuid().ToString("N").Substring(0, 6)})";
        }
    }
}
