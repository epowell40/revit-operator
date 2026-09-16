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
    public class CreateSheetHandler : IRequestHandler
    {
        public class Params
        {
            public string? name { get; set; }
            public string? number { get; set; }
            public long? titleBlockId { get; set; } // -1 or null => auto-pick first titleblock for real sheets
            public string? titleBlockName { get; set; }
            public string? referenceSheetNumber { get; set; }
            public bool? placeholder { get; set; } // create placeholder when true
            public long? convertPlaceholderSheetId { get; set; } // convert existing placeholder to real
        }

        public Task<object> Handle(UIApplication app, string jsonData)
        {
            var p = string.IsNullOrWhiteSpace(jsonData)
                ? new Params()
                : (JsonSerializer.Deserialize<Params>(jsonData) ?? new Params());
            var doc = app.ActiveUIDocument.Document;

            ElementId? outputId = null;
            var modified = new HashSet<long>();
            var result = RevitBridge.Logic.Handlers.NativeSingleTransaction.Execute(app, doc, "Create Sheet", created =>
            {
                var wantsPlaceholder = p.placeholder ?? false;
                ViewSheet sheet;
                ElementId? existingId = null;
                var existingOwned = new HashSet<ElementId>();

                if (p.convertPlaceholderSheetId.HasValue && p.convertPlaceholderSheetId.Value > 0)
                {
                    var existing = doc.GetElement(RevitBridge.Common.ElementIdCompat.Create(p.convertPlaceholderSheetId.Value)) as ViewSheet;
                    if (existing == null) throw new InvalidOperationException($"Placeholder sheet {p.convertPlaceholderSheetId.Value} not found.");
                    if (!existing.IsPlaceholder) throw new InvalidOperationException($"Sheet {p.convertPlaceholderSheetId.Value} is not a placeholder.");
                    existingId = existing.Id;
                    existingOwned.UnionWith(new FilteredElementCollector(doc).WherePasses(new ElementOwnerViewFilter(existing.Id)).ToElementIds());
                    var selection = ResolveTitleBlock(doc, p);
                    sheet = ConvertPlaceholderToReal(doc, existing, selection.TypeId);
                }
                else if (wantsPlaceholder)
                {
                    sheet = CreatePlaceholderSheet(doc);
                }
                else
                {
                    var selection = ResolveTitleBlock(doc, p);
                    sheet = ViewSheet.Create(doc, selection.TypeId);
                }

                if (!string.IsNullOrWhiteSpace(p.name)) sheet.Name = RevitBridge.Common.RevitTextCasePolicy.NormalizeSheetName(p.name);
                if (!string.IsNullOrWhiteSpace(p.number)) sheet.SheetNumber = p.number.Trim();

                doc.Regenerate();
                outputId = sheet.Id;
                if (sheet.Id == existingId) modified.Add(ElementIdCompat.GetValue(sheet.Id));
                else created.Add(ElementIdCompat.GetValue(sheet.Id));
                foreach (var id in new FilteredElementCollector(doc).WherePasses(new ElementOwnerViewFilter(sheet.Id)).ToElementIds())
                    if (!existingOwned.Contains(id)) created.Add(ElementIdCompat.GetValue(id));
                return new Dictionary<string, object?>();
            }, () => modified);
            return Task.FromResult<object>(OperatorNativeTransactionExecution.ReadCommitted(result, () =>
            {
                var sheet = outputId == null ? null : doc.GetElement(outputId) as ViewSheet;
                if (sheet == null) throw new InvalidOperationException("Committed sheet was not found during readback.");
                return new Dictionary<string, object?>
                {
                    ["id"] = ElementIdCompat.GetValue(sheet.Id), ["name"] = sheet.Name,
                    ["number"] = sheet.SheetNumber, ["isPlaceholder"] = sheet.IsPlaceholder,
                    ["titleBlock"] = sheet.IsPlaceholder ? null : ResolveTitleBlock(doc, p).ToResponse()
                };
            }));
        }

        private static TitleBlockSelection ResolveTitleBlock(Document doc, Params p)
        {
            return SheetTitleBlockSelectionHelper.Resolve(
                doc,
                p.titleBlockId ?? -1,
                p.titleBlockName,
                p.referenceSheetNumber,
                p.number);
        }

        private static ViewSheet CreatePlaceholderSheet(Document doc)
        {
            var createPlaceholder = typeof(ViewSheet).GetMethod(
                "CreatePlaceholder",
                BindingFlags.Public | BindingFlags.Static,
                binder: null,
                types: new[] { typeof(Document) },
                modifiers: null);

            if (createPlaceholder != null)
            {
                var raw = createPlaceholder.Invoke(null, new object[] { doc });
                if (raw is ViewSheet placeholderSheet) return placeholderSheet;
            }

            throw new InvalidOperationException("This Revit API version does not expose ViewSheet.CreatePlaceholder.");
        }

        private static ViewSheet ConvertPlaceholderToReal(Document doc, ViewSheet placeholderSheet, ElementId titleBlockTypeId)
        {
            if (placeholderSheet == null) throw new ArgumentNullException(nameof(placeholderSheet));
            if (titleBlockTypeId == null || titleBlockTypeId == ElementId.InvalidElementId)
                throw new InvalidOperationException("A valid title block type is required to convert placeholder sheets.");

            var type = placeholderSheet.GetType();
            var candidateMethods = new[]
            {
                type.GetMethod("ConvertToRealSheet", BindingFlags.Public | BindingFlags.Instance, null, new[] { typeof(ElementId) }, null),
                type.GetMethod("ConvertToSheet", BindingFlags.Public | BindingFlags.Instance, null, new[] { typeof(ElementId) }, null),
                type.GetMethod("ConvertToRealSheet", BindingFlags.Public | BindingFlags.Instance, null, Type.EmptyTypes, null),
                type.GetMethod("ConvertToSheet", BindingFlags.Public | BindingFlags.Instance, null, Type.EmptyTypes, null)
            }.Where(m => m != null).Cast<MethodInfo>().ToList();

            foreach (var method in candidateMethods)
            {
                var args = method.GetParameters().Length == 1
                    ? new object[] { titleBlockTypeId }
                    : Array.Empty<object>();
                var result = method.Invoke(placeholderSheet, args);
                if (result is ViewSheet vs) return vs;
                if (result is ElementId eid && eid != ElementId.InvalidElementId)
                {
                    var resolved = doc.GetElement(eid) as ViewSheet;
                    if (resolved != null) return resolved;
                }
            }

            throw new InvalidOperationException("This Revit API version does not expose placeholder-to-real conversion methods.");
        }
    }
}
