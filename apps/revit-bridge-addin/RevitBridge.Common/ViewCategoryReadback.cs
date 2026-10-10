using System;
using System.Collections.Generic;
using System.Linq;
using Autodesk.Revit.DB;

namespace RevitBridge.Common
{
    public static class ViewCategoryReadback
    {
        public static object Read(Document doc, View view, Category? target, bool targetRequested)
        {
            try
            {
                if (targetRequested && target == null) throw new InvalidOperationException("target_category_missing");
                var categories = new SortedDictionary<long, Category>();
                foreach (Category category in doc.Settings.Categories) Collect(category, categories, 0);
                var rows = new List<CategoryVisibilityState>();
                foreach (var pair in categories)
                {
                    var category = pair.Value;
                    var canHide = view.CanCategoryBeHidden(category.Id);
                    var overridable = view.IsCategoryOverridable(category.Id);
                    rows.Add(new CategoryVisibilityState
                    {
                        id = pair.Key, name = category.Name,
                        parentId = category.Parent == null ? (long?)null : ElementIdCompat.GetValue(category.Parent.Id),
                        canHide = canHide, hidden = canHide ? (bool?)view.GetCategoryHidden(category.Id) : null,
                        overridable = overridable,
                        graphics = overridable ? Graphics(view.GetCategoryOverrides(category.Id)) : null
                    });
                }
                return CategoryVisibilitySnapshot.Build(rows, target == null ? (long?)null : ElementIdCompat.GetValue(target.Id));
            }
            catch (Exception ex)
            {
                return new { schema = "revit.category-visibility-snapshot.v1", complete = false, reason = "category_snapshot_read_failed", errorType = ex.GetType().Name };
            }
        }

        private static void Collect(Category category, IDictionary<long, Category> categories, int depth)
        {
            if (depth > 8 || categories.Count >= CategoryVisibilitySnapshot.Limit) throw new InvalidOperationException("category_inventory_limit");
            var id = ElementIdCompat.GetValue(category.Id);
            if (categories.ContainsKey(id)) return;
            categories.Add(id, category);
            foreach (Category child in category.SubCategories) Collect(child, categories, depth + 1);
        }

        private static object? ColorValue(Color color) => color.IsValid ? new { r = color.Red, g = color.Green, b = color.Blue } : null;

        private static SortedDictionary<string, object?> Graphics(OverrideGraphicSettings g)
        {
            using (g)
                return new SortedDictionary<string, object?>(StringComparer.Ordinal)
                {
                    ["cutBackgroundPatternId"] = ElementIdCompat.GetValue(g.CutBackgroundPatternId),
                    ["cutForegroundPatternId"] = ElementIdCompat.GetValue(g.CutForegroundPatternId),
                    ["surfaceBackgroundPatternId"] = ElementIdCompat.GetValue(g.SurfaceBackgroundPatternId),
                    ["surfaceForegroundPatternId"] = ElementIdCompat.GetValue(g.SurfaceForegroundPatternId),
                    ["cutBackgroundPatternColor"] = ColorValue(g.CutBackgroundPatternColor),
                    ["cutForegroundPatternColor"] = ColorValue(g.CutForegroundPatternColor),
                    ["surfaceBackgroundPatternColor"] = ColorValue(g.SurfaceBackgroundPatternColor),
                    ["surfaceForegroundPatternColor"] = ColorValue(g.SurfaceForegroundPatternColor),
                    ["isCutBackgroundPatternVisible"] = g.IsCutBackgroundPatternVisible,
                    ["isCutForegroundPatternVisible"] = g.IsCutForegroundPatternVisible,
                    ["isSurfaceBackgroundPatternVisible"] = g.IsSurfaceBackgroundPatternVisible,
                    ["isSurfaceForegroundPatternVisible"] = g.IsSurfaceForegroundPatternVisible,
                    ["cutLinePatternId"] = ElementIdCompat.GetValue(g.CutLinePatternId),
                    ["cutLineColor"] = ColorValue(g.CutLineColor), ["cutLineWeight"] = g.CutLineWeight,
                    ["projectionLinePatternId"] = ElementIdCompat.GetValue(g.ProjectionLinePatternId),
                    ["projectionLineColor"] = ColorValue(g.ProjectionLineColor), ["projectionLineWeight"] = g.ProjectionLineWeight,
                    ["transparency"] = g.Transparency, ["detailLevel"] = g.DetailLevel.ToString(), ["halftone"] = g.Halftone
                };
        }
    }
}
