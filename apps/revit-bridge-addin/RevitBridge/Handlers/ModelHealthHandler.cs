using System;
using System.Collections.Generic;
using System.Linq;
using System.Text.Json;
using System.Threading.Tasks;
using Autodesk.Revit.DB;
using Autodesk.Revit.UI;

namespace RevitBridge.Handlers
{
    public sealed class ModelHealthHandler : IRequestHandler
    {
        private sealed class WarningGroup
        {
            public string description { get; set; } = "";
            public int count { get; set; }
        }

        private sealed class WarningSummary
        {
            public int count { get; set; }
            public List<WarningGroup> top { get; set; } = new List<WarningGroup>();
        }

        public class Params
        {
            public bool? includeWarnings { get; set; }
            public bool? includeLinks { get; set; }
            public bool? includeViews { get; set; }
            public bool? includeSheets { get; set; }
            public bool? includeSheetChecks { get; set; }
            public string? requiredSheetParameter { get; set; }
            public int? maxMissingSheetParams { get; set; }
            public int? maxUnplacedViews { get; set; }
        }

        public Task<object> Handle(UIApplication app, string jsonData)
        {
            var p = string.IsNullOrWhiteSpace(jsonData)
                ? new Params()
                : (JsonSerializer.Deserialize<Params>(jsonData) ?? new Params());

            var uidoc = app.ActiveUIDocument;
            var doc = uidoc?.Document;
            if (doc == null)
            {
                return Task.FromResult<object>(new
                {
                    status = "NoDocument",
                    message = "No active Revit document."
                });
            }

            var includeWarnings = p.includeWarnings ?? true;
            var includeLinks = p.includeLinks ?? true;
            var includeViews = p.includeViews ?? true;
            var includeSheets = p.includeSheets ?? true;
            var includeSheetChecks = p.includeSheetChecks ?? true;

            var sheets = new FilteredElementCollector(doc)
                .OfClass(typeof(ViewSheet))
                .Cast<ViewSheet>()
                .Where(s => s != null && !s.IsPlaceholder)
                .ToList();

            var views = new FilteredElementCollector(doc)
                .OfClass(typeof(View))
                .Cast<View>()
                .Where(v => v != null && !v.IsTemplate && v.ViewType != ViewType.DrawingSheet)
                .ToList();

            var placedViewIds = new HashSet<long>();
            foreach (var sheet in sheets)
            {
                foreach (var viewId in sheet.GetAllPlacedViews())
                {
                    placedViewIds.Add(RevitBridge.Common.ElementIdCompat.GetValue(viewId));
                }
            }

            var maxUnplacedViews = Clamp(p.maxUnplacedViews ?? 200, 1, 2000);
            var unplacedViews = views
                .Where(v => !placedViewIds.Contains(RevitBridge.Common.ElementIdCompat.GetValue(v.Id)))
                .OrderBy(v => v.Name, StringComparer.OrdinalIgnoreCase)
                .Take(maxUnplacedViews)
                .Select(v => new
                {
                    id = RevitBridge.Common.ElementIdCompat.GetValue(v.Id),
                    name = v.Name,
                    viewType = v.ViewType.ToString(),
                    canBePrinted = v.CanBePrinted
                })
                .ToList();

            var emptySheets = sheets
                .Where(s => s.GetAllViewports().Count == 0)
                .OrderBy(s => s.SheetNumber, StringComparer.OrdinalIgnoreCase)
                .Select(s => new
                {
                    sheetId = RevitBridge.Common.ElementIdCompat.GetValue(s.Id),
                    sheetNumber = s.SheetNumber,
                    sheetName = s.Name
                })
                .ToList();

            var requiredSheetParameter = (p.requiredSheetParameter ?? "").Trim();
            var missingSheetParameterValues = new List<object>();
            if (!string.IsNullOrWhiteSpace(requiredSheetParameter))
            {
                var maxMissing = Clamp(p.maxMissingSheetParams ?? 500, 1, 5000);
                foreach (var sheet in sheets.OrderBy(s => s.SheetNumber, StringComparer.OrdinalIgnoreCase))
                {
                    var param = sheet.LookupParameter(requiredSheetParameter);
                    var text = ToParameterString(param);
                    if (param == null || string.IsNullOrWhiteSpace(text))
                    {
                        missingSheetParameterValues.Add(new
                        {
                            sheetId = RevitBridge.Common.ElementIdCompat.GetValue(sheet.Id),
                            sheetNumber = sheet.SheetNumber,
                            sheetName = sheet.Name,
                            reason = param == null ? "ParameterNotFound" : "EmptyValue"
                        });
                    }

                    if (missingSheetParameterValues.Count >= maxMissing)
                    {
                        break;
                    }
                }
            }

            var warningSummary = includeWarnings
                ? BuildWarningSummary(doc)
                : null;

            var linkSummary = includeLinks
                ? BuildLinkSummary(doc)
                : null;

            return Task.FromResult<object>(new
            {
                status = "Ok",
                generatedAt = DateTime.UtcNow.ToString("o"),
                document = new
                {
                    title = doc.Title,
                    path = doc.PathName,
                    isWorkshared = doc.IsWorkshared
                },
                stats = new
                {
                    views = includeViews ? views.Count : (int?)null,
                    sheets = includeSheets ? sheets.Count : (int?)null,
                    warnings = includeWarnings ? warningSummary?.count : (int?)null,
                    emptySheets = includeSheetChecks ? emptySheets.Count : (int?)null,
                    unplacedViews = includeSheetChecks ? unplacedViews.Count : (int?)null,
                    missingRequiredSheetParameter = !string.IsNullOrWhiteSpace(requiredSheetParameter)
                        ? missingSheetParameterValues.Count
                        : (int?)null
                },
                warnings = warningSummary,
                links = linkSummary,
                sheetChecks = includeSheetChecks
                    ? new
                    {
                        emptySheets,
                        unplacedViews,
                        requiredSheetParameter = string.IsNullOrWhiteSpace(requiredSheetParameter) ? null : requiredSheetParameter,
                        missingRequiredSheetParameter = missingSheetParameterValues
                    }
                    : null
            });
        }

        private static WarningSummary BuildWarningSummary(Document doc)
        {
            var warnings = doc.GetWarnings();
            var top = warnings
                .Select(w => (w.GetDescriptionText() ?? "").Trim())
                .Where(s => !string.IsNullOrWhiteSpace(s))
                .GroupBy(s => s, StringComparer.Ordinal)
                .OrderByDescending(g => g.Count())
                .Take(10)
                .Select(g => new WarningGroup
                {
                    description = g.Key,
                    count = g.Count()
                })
                .ToList();

            return new WarningSummary
            {
                count = warnings.Count,
                top = top
            };
        }

        private static object BuildLinkSummary(Document doc)
        {
            var revitLinkInstances = new FilteredElementCollector(doc)
                .OfClass(typeof(RevitLinkInstance))
                .Cast<RevitLinkInstance>()
                .ToList();

            var revitLinks = revitLinkInstances
                .GroupBy(i => RevitBridge.Common.ElementIdCompat.GetValue(i.GetTypeId()))
                .Select(g =>
                {
                    var sample = g.First();
                    var linkDoc = sample.GetLinkDocument();
                    var typeElem = doc.GetElement(sample.GetTypeId()) as ElementType;
                    return new
                    {
                        typeId = g.Key,
                        name = typeElem?.Name ?? sample.Name,
                        instanceCount = g.Count(),
                        loaded = linkDoc != null,
                        path = linkDoc?.PathName
                    };
                })
                .OrderBy(x => x.name, StringComparer.OrdinalIgnoreCase)
                .ToList();

            var cadLinkInstances = new FilteredElementCollector(doc)
                .OfClass(typeof(ImportInstance))
                .Cast<ImportInstance>()
                .Where(i => i.IsLinked)
                .ToList();

            var cadLinks = cadLinkInstances
                .Select(i =>
                {
                    var ownerView = i.OwnerViewId;
                    var ownerViewValue = RevitBridge.Common.ElementIdCompat.GetValue(ownerView);
                    var ownerViewId = ownerView != null && ownerViewValue > 0 ? ownerViewValue : (long?)null;
                    return new
                    {
                        elementId = RevitBridge.Common.ElementIdCompat.GetValue(i.Id),
                        name = i.Name,
                        ownerViewId
                    };
                })
                .OrderBy(x => x.name, StringComparer.OrdinalIgnoreCase)
                .ToList();

            return new
            {
                revit = new
                {
                    totalTypes = revitLinks.Count,
                    totalInstances = revitLinkInstances.Count,
                    loadedTypes = revitLinks.Count(x => x.loaded),
                    unloadedTypes = revitLinks.Count(x => !x.loaded),
                    items = revitLinks
                },
                cad = new
                {
                    totalLinks = cadLinks.Count,
                    items = cadLinks
                }
            };
        }

        private static string ToParameterString(Parameter? param)
        {
            if (param == null) return "";

            switch (param.StorageType)
            {
                case StorageType.String:
                    return param.AsString() ?? "";
                case StorageType.Integer:
                    return param.AsInteger().ToString();
                case StorageType.Double:
                    return param.AsDouble().ToString();
                case StorageType.ElementId:
                    return RevitBridge.Common.ElementIdCompat.GetValue(param.AsElementId()).ToString();
                default:
                    return "";
            }
        }

        private static int Clamp(int value, int min, int max)
        {
            if (value < min) return min;
            if (value > max) return max;
            return value;
        }
    }
}
