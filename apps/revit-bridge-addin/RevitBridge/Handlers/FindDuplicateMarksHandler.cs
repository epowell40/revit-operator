using System;
using System.Collections.Generic;
using System.Linq;
using System.Text.Json;
using System.Threading.Tasks;
using Autodesk.Revit.DB;
using Autodesk.Revit.UI;

namespace RevitBridge.Handlers
{
    public sealed class FindDuplicateMarksHandler : IRequestHandler
    {
        public sealed class Params
        {
            public string? categoryName { get; set; }
            public string? parameterName { get; set; }
            public long? viewId { get; set; }
            public bool? includeEmpty { get; set; }
            public int? maxGroups { get; set; }
        }

        private sealed class ElementValue
        {
            public long elementId { get; set; }
            public string elementName { get; set; } = "";
            public string value { get; set; } = "";
        }

        private sealed class ResolvedCategory
        {
            public BuiltInCategory? builtInCategory { get; set; }
            public string builtInCategoryName { get; set; } = "";
            public string displayName { get; set; } = "";
        }

        public Task<object> Handle(UIApplication app, string jsonData)
        {
            var opts = new JsonSerializerOptions { PropertyNameCaseInsensitive = true };
            var p = string.IsNullOrWhiteSpace(jsonData)
                ? new Params()
                : (JsonSerializer.Deserialize<Params>(jsonData, opts) ?? new Params());

            var doc = app.ActiveUIDocument?.Document
                ?? throw new InvalidOperationException("No active Revit document.");

            var categoryName = (p.categoryName ?? "OST_DuctTerminal").Trim();
            var parameterNameInput = p.parameterName;
            var parameterName = string.IsNullOrWhiteSpace(parameterNameInput) ? "Mark" : parameterNameInput.Trim();
            var includeEmpty = p.includeEmpty ?? false;
            var maxGroups = p.maxGroups ?? 200;

            if (string.IsNullOrWhiteSpace(categoryName))
            {
                throw new InvalidOperationException("find-duplicate-marks.categoryName cannot be empty.");
            }

            if (maxGroups <= 0 || maxGroups > 5000)
            {
                throw new InvalidOperationException("find-duplicate-marks.maxGroups must be between 1 and 5000.");
            }

            View? scopeView = null;
            if (p.viewId.HasValue)
            {
                if (p.viewId.Value <= 0)
                {
                    throw new InvalidOperationException("find-duplicate-marks.viewId must be > 0 when provided.");
                }

                scopeView = doc.GetElement(RevitBridge.Common.ElementIdCompat.Create(p.viewId.Value)) as View;
                if (scopeView == null)
                {
                    throw new InvalidOperationException($"find-duplicate-marks.viewId {p.viewId.Value} was not found or is not a view.");
                }
            }

            var resolvedCategory = ResolveCategory(doc, categoryName);
            if (resolvedCategory == null)
            {
                throw new InvalidOperationException(
                    $"find-duplicate-marks.categoryName '{categoryName}' was not found. Use a BuiltInCategory name (for example OST_DuctTerminal) or an exact category display name.");
            }

            var collector = scopeView != null
                ? new FilteredElementCollector(doc, scopeView.Id)
                : new FilteredElementCollector(doc);
            collector = collector.WhereElementIsNotElementType();

            if (resolvedCategory.builtInCategory.HasValue)
            {
                collector = collector.OfCategory(resolvedCategory.builtInCategory.Value);
            }
            else
            {
                throw new InvalidOperationException($"Category '{resolvedCategory.displayName}' cannot be used with an element collector category filter.");
            }

            var elements = collector.ToElements();
            var values = new List<ElementValue>(elements.Count);
            var missingParameterCount = 0;
            var emptyValueCount = 0;

            foreach (var element in elements)
            {
                var parameter = element.LookupParameter(parameterName);
                if (parameter == null && parameterName.Equals("Mark", StringComparison.OrdinalIgnoreCase))
                {
                    parameter = element.get_Parameter(BuiltInParameter.ALL_MODEL_MARK);
                }

                if (parameter == null)
                {
                    missingParameterCount++;
                    continue;
                }

                var value = ToComparableValue(parameter).Trim();
                if (string.IsNullOrWhiteSpace(value))
                {
                    emptyValueCount++;
                    if (!includeEmpty) continue;
                    value = "";
                }

                values.Add(new ElementValue
                {
                    elementId = RevitBridge.Common.ElementIdCompat.GetValue(element.Id),
                    elementName = element.Name ?? "",
                    value = value
                });
            }

            var duplicateGroups = values
                .GroupBy(v => v.value, StringComparer.OrdinalIgnoreCase)
                .Where(g => g.Count() > 1)
                .OrderByDescending(g => g.Count())
                .ThenBy(g => g.Key, StringComparer.OrdinalIgnoreCase)
                .ToList();

            var totalDuplicateGroups = duplicateGroups.Count;
            var groups = duplicateGroups
                .Take(maxGroups)
                .Select(g => new
                {
                    value = g.Key,
                    isEmpty = string.IsNullOrEmpty(g.Key),
                    count = g.Count(),
                    elements = g
                        .OrderBy(x => x.elementName, StringComparer.OrdinalIgnoreCase)
                        .ThenBy(x => x.elementId)
                        .Select(x => new
                        {
                            elementId = x.elementId,
                            name = x.elementName
                        })
                        .ToList()
                })
                .ToList();

            return Task.FromResult<object>(new
            {
                status = "Success",
                category = new
                {
                    input = categoryName,
                    resolvedDisplayName = resolvedCategory.displayName,
                    resolvedBuiltInCategory = resolvedCategory.builtInCategoryName
                },
                parameter = parameterName,
                scope = new
                {
                    viewId = RevitBridge.Common.ElementIdCompat.GetValue(scopeView?.Id),
                    viewName = scopeView?.Name
                },
                summary = new
                {
                    totalElements = elements.Count,
                    elementsWithParameterValues = values.Count,
                    missingParameterCount,
                    emptyValueCount,
                    includeEmpty,
                    duplicateGroupsFound = totalDuplicateGroups,
                    duplicateGroupsReturned = groups.Count,
                    maxGroups
                },
                groups
            });
        }

        private static ResolvedCategory? ResolveCategory(Document doc, string input)
        {
            if (Enum.TryParse<BuiltInCategory>(input, true, out var bic))
            {
                var bicCategory = Category.GetCategory(doc, bic);
                return new ResolvedCategory
                {
                    builtInCategory = bic,
                    builtInCategoryName = bic.ToString(),
                    displayName = bicCategory?.Name ?? bic.ToString()
                };
            }

            var categories = doc.Settings?.Categories;
            if (categories == null) return null;

            foreach (Category c in categories)
            {
                if (!string.Equals(c.Name, input, StringComparison.OrdinalIgnoreCase)) continue;

                var catBic = c.BuiltInCategory;
                if (catBic == BuiltInCategory.INVALID) continue;

                return new ResolvedCategory
                {
                    builtInCategory = catBic,
                    builtInCategoryName = catBic.ToString(),
                    displayName = c.Name
                };
            }

            return null;
        }

        private static string ToComparableValue(Parameter parameter)
        {
            if (parameter == null) return "";

            switch (parameter.StorageType)
            {
                case StorageType.String:
                    return parameter.AsString() ?? "";
                case StorageType.Integer:
                    return parameter.AsInteger().ToString();
                case StorageType.Double:
                    return parameter.AsValueString() ?? parameter.AsDouble().ToString("G17");
                case StorageType.ElementId:
                    return RevitBridge.Common.ElementIdCompat.GetValue(parameter.AsElementId()).ToString();
                default:
                    return parameter.AsValueString() ?? "";
            }
        }
    }
}
