using System;
using System.Collections.Generic;
using System.Linq;
using System.Text.Json;
using System.Threading.Tasks;
using Autodesk.Revit.DB;
using Autodesk.Revit.UI;

namespace RevitBridge.Handlers
{
    public sealed class ListSheetsHandler : IRequestHandler
    {
        private sealed class Params
        {
            public string? action { get; set; } // "list" (default) | "detail" | "count"
            public string? query { get; set; }
            public bool? exact { get; set; }
            public int? max { get; set; } // legacy alias for limit

            // v2 additions
            public string? sheetNumberPrefix { get; set; }
            public int? offset { get; set; }
            public int? limit { get; set; }
            public bool? all { get; set; }
            public bool? countOnly { get; set; } // legacy alias for action:"count"

            // detail mode selectors
            public string? sheetNumber { get; set; }
            public long? sheetId { get; set; }
            public long? viewId { get; set; }
            public bool? includePlacedViews { get; set; }
            public bool? includeViewports { get; set; }
            public bool? includeTitleBlocks { get; set; }
            public bool? includeViewportGeometry { get; set; }
            public bool? includeSheetOutline { get; set; }
        }

        public Task<object> Handle(UIApplication app, string jsonData)
        {
            var p = string.IsNullOrWhiteSpace(jsonData) ? new Params() : (JsonSerializer.Deserialize<Params>(jsonData) ?? new Params());
            var action = (p.action ?? "list").Trim();
            var actionLower = action.ToLowerInvariant();
            var q = (p.query ?? "").Trim();
            var prefix = (p.sheetNumberPrefix ?? "").Trim();
            var exact = p.exact ?? false;
            var doc = app.ActiveUIDocument.Document;
            var countOnly = (p.countOnly ?? false) || actionLower.Equals("count", StringComparison.OrdinalIgnoreCase);

            if (actionLower.Equals("detail", StringComparison.OrdinalIgnoreCase))
            {
                return Task.FromResult<object>(BuildSheetDetail(doc, p, q, exact));
            }

            var defaultLimit = 500;
            var maxLimit = 5000;
            var capAll = 500;
            var all = p.all ?? false;
            var offset = p.offset.HasValue && p.offset.Value > 0 ? p.offset.Value : 0;
            var limitRaw = p.limit ?? p.max ?? defaultLimit;
            var limit = limitRaw > 0 ? Math.Min(limitRaw, maxLimit) : defaultLimit;
            if (all)
            {
                offset = 0;
                limit = capAll;
            }
            if (countOnly)
            {
                offset = 0;
                limit = 0;
            }

            var items = new List<object>(capacity: Math.Min(64, limit));

            // Collect all sheets. ViewSheet is a view element, so its Id can be used as a viewId for print/export.
            var sheets = new FilteredElementCollector(doc)
                .OfClass(typeof(ViewSheet))
                .Cast<ViewSheet>()
                .Where(s => s != null && !s.IsPlaceholder)
                .ToList();

            IEnumerable<ViewSheet> filtered = sheets;

            if (string.IsNullOrWhiteSpace(prefix) && !string.IsNullOrWhiteSpace(q) && q.EndsWith("*", StringComparison.Ordinal))
            {
                prefix = q.TrimEnd('*').Trim();
            }

            if (!string.IsNullOrWhiteSpace(prefix))
            {
                filtered = filtered.Where(s => (s.SheetNumber ?? "").StartsWith(prefix, StringComparison.OrdinalIgnoreCase));
            }
            else if (!string.IsNullOrWhiteSpace(q))
            {
                filtered = filtered.Where(s =>
                {
                    var sn = (s.SheetNumber ?? "").Trim();
                    var name = (s.Name ?? "").Trim();
                    if (exact)
                        return sn.Equals(q, StringComparison.OrdinalIgnoreCase) || name.Equals(q, StringComparison.OrdinalIgnoreCase);
                    return sn.IndexOf(q, StringComparison.OrdinalIgnoreCase) >= 0 || name.IndexOf(q, StringComparison.OrdinalIgnoreCase) >= 0;
                });
            }

            var sorted = filtered
                .OrderBy(s => s.SheetNumber, StringComparer.OrdinalIgnoreCase)
                .ThenBy(s => s.Name, StringComparer.OrdinalIgnoreCase)
                .ToList();

            var totalMatches = sorted.Count;
            var page = countOnly ? new List<ViewSheet>() : sorted.Skip(offset).Take(limit).ToList();

            foreach (var s in page)
            {
                if (items.Count >= limit) break;
                items.Add(new
                {
                    id = RevitBridge.Common.ElementIdCompat.GetValue(s.Id),
                    viewId = RevitBridge.Common.ElementIdCompat.GetValue(s.Id),
                    sheetNumber = s.SheetNumber,
                    name = s.Name
                });
            }

            var returned = items.Count;
            var hasMore = !countOnly && (offset + returned < totalMatches);
            int? nextOffset = hasMore ? offset + returned : (int?)null;
            int? totalPages = (!countOnly && limit > 0) ? (int)Math.Ceiling((double)totalMatches / limit) : (int?)null;
            int? pageIndex = (!countOnly && limit > 0) ? (offset / limit) : (int?)null;
            string? note = null;
            if (countOnly)
            {
                note = "Count mode returns totals only. Use action:list to fetch sheet rows.";
            }
            else if (all && totalMatches > capAll)
            {
                note = $"Capped results to {capAll}. Use paging with offset/limit to fetch the rest.";
            }
            else if (hasMore)
            {
                note = $"More matches are available. Continue with offset={nextOffset}.";
            }

            return Task.FromResult<object>(new
            {
                action = countOnly ? "count" : "list",
                countOnly,
                totalSheets = sheets.Count,
                totalMatches,
                total = totalMatches, // stable alias for clients expecting `total`
                returned,
                query = q,
                sheetNumberPrefix = string.IsNullOrWhiteSpace(prefix) ? null : prefix,
                exact,
                offset,
                limit,
                defaultLimit,
                maxLimit,
                all,
                hasMore,
                nextOffset,
                totalPages,
                pageIndex,
                paging = new
                {
                    offset,
                    limit,
                    returned,
                    hasMore,
                    nextOffset
                },
                items,
                note
            });
        }

        private static object BuildSheetDetail(Document doc, Params p, string query, bool exact)
        {
            var includePlacedViews = p.includePlacedViews ?? true;
            var includeViewports = p.includeViewports ?? true;
            var includeTitleBlocks = p.includeTitleBlocks ?? true;
            var includeViewportGeometry = p.includeViewportGeometry ?? true;
            var includeSheetOutline = p.includeSheetOutline ?? true;

            var sheet = ResolveSheet(doc, p, query, exact);
            if (sheet == null)
            {
                return new
                {
                    status = "NotFound",
                    action = "detail",
                    message = "Sheet not found. Provide sheetNumber, sheetId, viewId, or query.",
                    selector = new
                    {
                        sheetNumber = string.IsNullOrWhiteSpace(p.sheetNumber) ? null : p.sheetNumber.Trim(),
                        p.sheetId,
                        p.viewId,
                        query = string.IsNullOrWhiteSpace(query) ? null : query,
                        exact
                    }
                };
            }

            var viewportIds = new List<long>();
            var placedViews = new List<object>();
            var viewportGeometry = new List<object>();

            var viewportByViewId = new Dictionary<long, List<long>>();
            var viewportIdSet = new HashSet<long>();

            foreach (var vpId in sheet.GetAllViewports())
            {
                var vpid = RevitBridge.Common.ElementIdCompat.GetValue(vpId);
                viewportIds.Add(vpid);
                viewportIdSet.Add(vpid);

                var vp = doc.GetElement(vpId) as Viewport;
                if (vp == null) continue;
                var key = RevitBridge.Common.ElementIdCompat.GetValue(vp.ViewId);
                if (!viewportByViewId.TryGetValue(key, out var list))
                {
                    list = new List<long>();
                    viewportByViewId[key] = list;
                }
                list.Add(vpid);

                if (includeViewportGeometry)
                {
                    object? box = null;
                    try
                    {
                        var o = vp.GetBoxOutline();
                        box = new
                        {
                            minU = o.MinimumPoint.X,
                            minV = o.MinimumPoint.Y,
                            maxU = o.MaximumPoint.X,
                            maxV = o.MaximumPoint.Y
                        };
                    }
                    catch
                    {
                        box = null;
                    }

                    object? center = null;
                    try
                    {
                        var c = vp.GetBoxCenter();
                        center = new { u = c.X, v = c.Y };
                    }
                    catch
                    {
                        center = null;
                    }

                    viewportGeometry.Add(new
                    {
                        viewportId = vpid,
                        viewId = key,
                        rotation = vp.Rotation.ToString(),
                        center,
                        box
                    });
                }
            }

            foreach (var viewId in sheet.GetAllPlacedViews())
            {
                var viewElem = doc.GetElement(viewId) as View;
                var key = RevitBridge.Common.ElementIdCompat.GetValue(viewId);
                viewportByViewId.TryGetValue(key, out var onSheetViewportIds);
                placedViews.Add(new
                {
                    viewId = key,
                    name = viewElem?.Name,
                    viewType = viewElem?.ViewType.ToString(),
                    scale = viewElem?.Scale,
                    viewportIds = onSheetViewportIds ?? new List<long>()
                });
            }

            var titleBlocks = new List<object>();
            foreach (var tb in new FilteredElementCollector(doc, sheet.Id)
                .OfCategory(BuiltInCategory.OST_TitleBlocks)
                .WhereElementIsNotElementType())
            {
                var symbol = doc.GetElement(tb.GetTypeId()) as FamilySymbol;
                object? bbox = null;
                try
                {
                    var bb = tb.get_BoundingBox(sheet);
                    if (bb != null)
                    {
                        bbox = new
                        {
                            minU = bb.Min.X,
                            minV = bb.Min.Y,
                            maxU = bb.Max.X,
                            maxV = bb.Max.Y
                        };
                    }
                }
                catch
                {
                    bbox = null;
                }
                titleBlocks.Add(new
                {
                    elementId = RevitBridge.Common.ElementIdCompat.GetValue(tb.Id),
                    typeId = RevitBridge.Common.ElementIdCompat.GetValue(tb.GetTypeId()),
                    familyName = symbol?.FamilyName,
                    typeName = symbol?.Name,
                    boundingBox = bbox
                });
            }

            object? sheetOutline = null;
            if (includeSheetOutline)
            {
                try
                {
                    var o = sheet.Outline;
                    sheetOutline = new
                    {
                        minU = o.Min.U,
                        minV = o.Min.V,
                        maxU = o.Max.U,
                        maxV = o.Max.V
                    };
                }
                catch
                {
                    sheetOutline = null;
                }
            }

            return new
            {
                status = "Ok",
                action = "detail",
                sheetElementId = RevitBridge.Common.ElementIdCompat.GetValue(sheet.Id),
                sheetId = RevitBridge.Common.ElementIdCompat.GetValue(sheet.Id),
                viewId = RevitBridge.Common.ElementIdCompat.GetValue(sheet.Id),
                sheetNumber = sheet.SheetNumber,
                sheetName = sheet.Name,
                title = sheet.Name,
                isPlaceholder = sheet.IsPlaceholder,
                viewportCount = viewportIds.Count,
                placedViewCount = placedViews.Count,
                titleBlockCount = titleBlocks.Count,
                sheetOutline = includeSheetOutline ? sheetOutline : null,
                viewportIds = includeViewports ? viewportIds : null,
                viewportGeometry = includeViewportGeometry ? viewportGeometry : null,
                placedViews = includePlacedViews ? placedViews : null,
                titleBlocks = includeTitleBlocks ? titleBlocks : null
            };
        }

        private static ViewSheet? ResolveSheet(Document doc, Params p, string query, bool exact)
        {
            if (p.sheetId.HasValue)
            {
                var bySheetId = doc.GetElement(RevitBridge.Common.ElementIdCompat.Create(p.sheetId.Value)) as ViewSheet;
                if (bySheetId != null) return bySheetId;
            }

            if (p.viewId.HasValue)
            {
                var byViewId = doc.GetElement(RevitBridge.Common.ElementIdCompat.Create(p.viewId.Value)) as ViewSheet;
                if (byViewId != null) return byViewId;
            }

            var sheetNumber = (p.sheetNumber ?? "").Trim();
            var byNumber = !string.IsNullOrWhiteSpace(sheetNumber)
                ? new FilteredElementCollector(doc)
                    .OfClass(typeof(ViewSheet))
                    .Cast<ViewSheet>()
                    .FirstOrDefault(s => !s.IsPlaceholder && string.Equals((s.SheetNumber ?? "").Trim(), sheetNumber, StringComparison.OrdinalIgnoreCase))
                : null;
            if (byNumber != null) return byNumber;

            if (!string.IsNullOrWhiteSpace(query))
            {
                var candidates = new FilteredElementCollector(doc)
                    .OfClass(typeof(ViewSheet))
                    .Cast<ViewSheet>()
                    .Where(s => !s.IsPlaceholder)
                    .Where(s =>
                    {
                        var sn = (s.SheetNumber ?? "").Trim();
                        var name = (s.Name ?? "").Trim();
                        if (exact)
                        {
                            return sn.Equals(query, StringComparison.OrdinalIgnoreCase) ||
                                   name.Equals(query, StringComparison.OrdinalIgnoreCase);
                        }
                        return sn.IndexOf(query, StringComparison.OrdinalIgnoreCase) >= 0 ||
                               name.IndexOf(query, StringComparison.OrdinalIgnoreCase) >= 0;
                    })
                    .OrderBy(s => s.SheetNumber, StringComparer.OrdinalIgnoreCase)
                    .ThenBy(s => s.Name, StringComparer.OrdinalIgnoreCase)
                    .ToList();

                if (candidates.Count > 0)
                {
                    return candidates[0];
                }
            }

            return null;
        }
    }
}
