using System;
using System.Linq;
using System.Reflection;
using System.Text.Json;
using System.Threading.Tasks;
using Autodesk.Revit.DB;
using Autodesk.Revit.UI;

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

            using (Transaction trans = new Transaction(doc, "Create Sheet"))
            {
                trans.Start();

                var wantsPlaceholder = p.placeholder ?? false;
                ViewSheet sheet;

                if (p.convertPlaceholderSheetId.HasValue && p.convertPlaceholderSheetId.Value > 0)
                {
                    var existing = doc.GetElement(RevitBridge.Common.ElementIdCompat.Create(p.convertPlaceholderSheetId.Value)) as ViewSheet;
                    if (existing == null) throw new InvalidOperationException($"Placeholder sheet {p.convertPlaceholderSheetId.Value} not found.");
                    if (!existing.IsPlaceholder) throw new InvalidOperationException($"Sheet {p.convertPlaceholderSheetId.Value} is not a placeholder.");

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

                trans.Commit();

                var selectedTitleBlock = sheet.IsPlaceholder ? null : ResolveTitleBlock(doc, p).ToResponse();

                return Task.FromResult<object>(new 
                { 
                    id = RevitBridge.Common.ElementIdCompat.GetValue(sheet.Id), 
                    name = sheet.Name, 
                    number = sheet.SheetNumber,
                    isPlaceholder = sheet.IsPlaceholder,
                    titleBlock = selectedTitleBlock
                });
            }
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
