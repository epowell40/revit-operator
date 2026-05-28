using System;
using System.Collections;
using System.Collections.Generic;
using System.Linq;
using System.Reflection;
using System.Text.Json;
using System.Threading.Tasks;
using Autodesk.Revit.DB;
using Autodesk.Revit.UI;

namespace RevitBridge.Handlers
{
    public sealed class PrintSetsHandler : IRequestHandler
    {
        public sealed class Params
        {
            public string? action { get; set; } // list (default) | detail
            public string? name { get; set; }
            public bool? includeSheets { get; set; }
            public int? max { get; set; }
        }

        public Task<object> Handle(UIApplication app, string jsonData)
        {
            var p = string.IsNullOrWhiteSpace(jsonData)
                ? new Params()
                : (JsonSerializer.Deserialize<Params>(jsonData) ?? new Params());

            var doc = app.ActiveUIDocument?.Document;
            if (doc == null)
            {
                return Task.FromResult<object>(new
                {
                    status = "NoDocument",
                    message = "No active Revit document."
                });
            }

            var action = (p.action ?? "list").Trim().ToLowerInvariant();
            if (action == "detail")
            {
                return Task.FromResult<object>(BuildDetail(doc, p));
            }

            return Task.FromResult<object>(BuildList(doc, p));
        }

        private static object BuildList(Document doc, Params p)
        {
            var includeSheets = p.includeSheets ?? false;
            var max = p.max.HasValue && p.max.Value > 0 ? Math.Min(p.max.Value, 500) : 200;

            var sets = new FilteredElementCollector(doc)
                .OfClass(typeof(ViewSheetSet))
                .Cast<ViewSheetSet>()
                .OrderBy(s => s.Name, StringComparer.OrdinalIgnoreCase)
                .Take(max)
                .ToList();

            var items = new List<object>(sets.Count);
            foreach (var set in sets)
            {
                var sheets = GetSheetsInSet(set);
                items.Add(new
                {
                    id = RevitBridge.Common.ElementIdCompat.GetValue(set.Id),
                    name = set.Name,
                    sheetCount = sheets.Count,
                    sheets = includeSheets
                        ? sheets.Select(s => new
                        {
                            sheetId = RevitBridge.Common.ElementIdCompat.GetValue(s.Id),
                            sheetNumber = s.SheetNumber,
                            sheetName = s.Name
                        }).ToList()
                        : null
                });
            }

            return new
            {
                status = "Ok",
                action = "list",
                returned = items.Count,
                items
            };
        }

        private static object BuildDetail(Document doc, Params p)
        {
            var name = (p.name ?? "").Trim();
            if (string.IsNullOrWhiteSpace(name))
            {
                return new
                {
                    status = "InvalidRequest",
                    action = "detail",
                    message = "print-sets(detail) requires name."
                };
            }

            var set = FindByName(doc, name);
            if (set == null)
            {
                return new
                {
                    status = "NotFound",
                    action = "detail",
                    name
                };
            }

            var sheets = GetSheetsInSet(set);
            return new
            {
                status = "Ok",
                action = "detail",
                id = RevitBridge.Common.ElementIdCompat.GetValue(set.Id),
                name = set.Name,
                sheetCount = sheets.Count,
                sheets = sheets.Select(s => new
                {
                    sheetId = RevitBridge.Common.ElementIdCompat.GetValue(s.Id),
                    sheetNumber = s.SheetNumber,
                    sheetName = s.Name
                }).ToList()
            };
        }

        internal static ViewSheetSet? FindByName(Document doc, string name)
        {
            var wanted = (name ?? "").Trim();
            if (string.IsNullOrWhiteSpace(wanted)) return null;

            return new FilteredElementCollector(doc)
                .OfClass(typeof(ViewSheetSet))
                .Cast<ViewSheetSet>()
                .FirstOrDefault(s => string.Equals((s.Name ?? "").Trim(), wanted, StringComparison.OrdinalIgnoreCase));
        }

        internal static List<ViewSheet> GetSheetsInSet(ViewSheetSet set)
        {
            var sheets = new List<ViewSheet>();
            if (set == null) return sheets;

            var viewsProp = set.GetType().GetProperty("Views", BindingFlags.Instance | BindingFlags.Public);
            if (viewsProp == null) return sheets;

            var raw = viewsProp.GetValue(set, null);
            if (raw == null) return sheets;

            if (raw is ViewSet viewSet)
            {
                foreach (View v in viewSet)
                {
                    if (v is ViewSheet sheet && !sheet.IsPlaceholder)
                    {
                        sheets.Add(sheet);
                    }
                }
                return sheets;
            }

            if (raw is IEnumerable enumerable)
            {
                foreach (var item in enumerable)
                {
                    if (item is ViewSheet sheet && !sheet.IsPlaceholder)
                    {
                        sheets.Add(sheet);
                    }
                    else if (item is View v && v is ViewSheet sheetView && !sheetView.IsPlaceholder)
                    {
                        sheets.Add(sheetView);
                    }
                }
            }

            return sheets
                .GroupBy(s => RevitBridge.Common.ElementIdCompat.GetValue(s.Id))
                .Select(g => g.First())
                .OrderBy(s => s.SheetNumber, StringComparer.OrdinalIgnoreCase)
                .ThenBy(s => s.Name, StringComparer.OrdinalIgnoreCase)
                .ToList();
        }
    }
}
