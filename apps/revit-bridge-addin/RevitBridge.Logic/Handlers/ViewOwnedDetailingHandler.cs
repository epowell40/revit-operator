using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Text.Json;
using System.Threading.Tasks;
using Autodesk.Revit.DB;
using Autodesk.Revit.DB.Architecture;
using Autodesk.Revit.DB.Mechanical;
using Autodesk.Revit.UI;
using RevitBridge.Common;

namespace RevitBridge.Logic.Handlers
{
    /// <summary>Read-only, owner-view inventory for comparing a source view with a detailed copy.</summary>
    public sealed class ViewOwnedDetailingHandler : IRequestHandler
    {
        public sealed class Request
        {
            public long? viewId { get; set; }
            public List<long>? viewIds { get; set; }
            public int? limit { get; set; }
        }

        public Task<object> Handle(UIApplication app, string jsonData)
        {
            var request = JsonSerializer.Deserialize<Request>(jsonData)
                ?? throw new ArgumentException("view-owned-detailing request is required.");
            if (request.viewId.HasValue && request.viewIds != null)
                throw new ArgumentException("Supply viewId or viewIds, not both.");
            var ids = request.viewIds ?? (request.viewId.HasValue ? new List<long> { request.viewId.Value } : new List<long>());
            if (ids.Count < 1 || ids.Count > 2 || ids.Any(id => id <= 0) || ids.Distinct().Count() != ids.Count)
                throw new ArgumentException("view-owned-detailing requires one or two distinct positive view IDs.");
            var limit = ViewOwnedDetailingInventoryContract.ValidateLimit(request.limit);
            var doc = app.ActiveUIDocument?.Document ?? throw new InvalidOperationException("No active project document.");
            var views = new List<object>();
            var viewsComplete = true;
            foreach (var id in ids)
            {
                var view = doc.GetElement(ElementIdCompat.Create(id)) as View
                    ?? throw new ArgumentException($"View {id} not found.");
                var inventory = ReadView(doc, view, limit);
                views.Add(inventory.payload);
                viewsComplete &= inventory.complete;
            }
            return Task.FromResult<object>(new
            {
                schema = "revit-operator.view-owned-detailing/v1",
                documentTitle = doc.Title,
                scope = "exact_owner_view",
                requestedViewIds = ids,
                viewsComplete,
                views
            });
        }

        private static (object payload, bool complete) ReadView(Document doc, View view, int limit)
        {
            // A view-scoped collector also returns visible model elements. This exact owner
            // filter is the same native relation used by DuplicateViewHandler's receipt.
            var owned = new FilteredElementCollector(doc)
                .WherePasses(new ElementOwnerViewFilter(view.Id))
                .WhereElementIsNotElementType()
                .ToElements()
                .OrderBy(element => ElementIdCompat.GetValue(element.Id))
                .ToList();
            var items = new List<object>(owned.Count);
            var unreadableIds = new List<long>();
            var annotationCount = 0;
            var unclassifiedCount = 0;
            var incompleteTextCount = 0;
            var incompleteSignatureCount = 0;
            foreach (var element in owned)
            {
                try
                {
                    if (element.OwnerViewId != view.Id)
                        throw new InvalidOperationException("Owner-view filter returned an element with another owner.");
                    var categoryType = element.Category?.CategoryType.ToString();
                    if (categoryType == "Annotation") annotationCount++;
                    var builtInCategory = element.Category?.BuiltInCategory.ToString();
                    var comparisonExcluded = ViewOwnedDetailingInventoryContract.IsNonDraftingInfrastructure(
                        element.GetType().Name, builtInCategory, categoryType == "Annotation", element.Name);
                    if (categoryType == null && !comparisonExcluded) unclassifiedCount++;
                    var text = ReadVisibleText(element);
                    var textComplete = text == null || text.Length <= 4096;
                    if (!textComplete)
                    {
                        incompleteTextCount++;
                        text = text!.Substring(0, 4096);
                    }
                    var type = doc.GetElement(element.GetTypeId());
                    var box = SafeBoundingBox(element, view);
                    var curve = element is CurveElement curveElement ? SafeCurve(curveElement) : null;
                    var geometryKey = RelativeGeometryKey(element, view);
                    var signatureComplete = !comparisonExcluded && categoryType != null && textComplete && geometryKey != null;
                    if (!signatureComplete && !comparisonExcluded) incompleteSignatureCount++;
                    var signature = signatureComplete
                        ? ViewOwnedDetailingSemanticSignature.Create(element.GetType().Name,
                            element.Category?.BuiltInCategory.ToString() ?? element.Category!.Name,
                            type?.UniqueId, text, geometryKey!)
                        : null;
                    items.Add(new
                    {
                        elementId = ElementIdCompat.GetValue(element.Id),
                        uniqueId = element.UniqueId,
                        ownerViewId = ElementIdCompat.GetValue(view.Id),
                        className = element.GetType().Name,
                        category = element.Category?.Name,
                        builtInCategory,
                        categoryType,
                        isAnnotation = categoryType == "Annotation",
                        comparisonExcluded,
                        name = element.Name,
                        typeId = type == null ? (long?)null : ElementIdCompat.GetValue(type.Id),
                        typeUniqueId = type?.UniqueId,
                        visibleText = text,
                        textComplete,
                        semanticSignature = signature,
                        semanticSignatureComplete = signatureComplete,
                        semanticGeometryKey = geometryKey,
                        boundingBox = box,
                        curve
                    });
                }
                catch
                {
                    unreadableIds.Add(ElementIdCompat.GetValue(element.Id));
                }
            }
            var bounded = ViewOwnedDetailingInventoryContract.Bound(items, limit, unreadableIds.Count);
            var complete = bounded.ItemsComplete && unclassifiedCount == 0 && incompleteTextCount == 0
                && incompleteSignatureCount == 0;
            var payload = new
            {
                view = new { id = ElementIdCompat.GetValue(view.Id), uniqueId = view.UniqueId, name = view.Name,
                    viewType = view.ViewType.ToString() },
                limit,
                totalOwnedCount = bounded.TotalOwnedCount,
                annotationCount,
                returnedCount = bounded.Items.Count,
                truncated = bounded.Truncated,
                unreadableCount = bounded.UnreadableCount,
                unreadableElementIds = unreadableIds.Take(20).ToArray(),
                unclassifiedCount,
                incompleteTextCount,
                incompleteSignatureCount,
                itemsComplete = complete,
                items = bounded.Items
            };
            return (payload, complete);
        }

        private static string? ReadVisibleText(Element element)
        {
            if (element is TextNote textNote) return textNote.Text;
            if (element is RoomTag roomTag) return roomTag.TagText;
            if (element is SpaceTag spaceTag) return spaceTag.TagText;
            if (element is IndependentTag independentTag) return independentTag.TagText;
            return null;
        }

        private static object? SafeBoundingBox(Element element, View view)
        {
            try
            {
                var box = element.get_BoundingBox(view) ?? element.get_BoundingBox(null);
                return box == null ? null : new { min = Point(box.Min), max = Point(box.Max) };
            }
            catch { return null; }
        }

        private static object? SafeCurve(CurveElement element)
        {
            try
            {
                var curve = element.GeometryCurve;
                return curve == null ? null : new { kind = curve.GetType().Name,
                    start = Point(curve.GetEndPoint(0)), end = Point(curve.GetEndPoint(1)) };
            }
            catch { return null; }
        }

        private static string? RelativeGeometryKey(Element element, View view)
        {
            try
            {
                var origin = view.Origin;
                var right = view.RightDirection.Normalize();
                var up = view.UpDirection.Normalize();
                var depth = view.ViewDirection.Normalize();
                string Position(XYZ value)
                {
                    var relative = value - origin;
                    return string.Join(",", new[] { relative.DotProduct(right), relative.DotProduct(up),
                        relative.DotProduct(depth) }.Select(number => Math.Round(number, 4)
                        .ToString("F4", CultureInfo.InvariantCulture)));
                }
                string Direction(XYZ value)
                {
                    var normalized = value.Normalize();
                    return string.Join(",", new[] { normalized.DotProduct(right), normalized.DotProduct(up),
                        normalized.DotProduct(depth) }.Select(number => Math.Round(number, 4)
                        .ToString("F4", CultureInfo.InvariantCulture)));
                }
                if (element is CurveElement curveElement)
                {
                    var curve = curveElement.GeometryCurve;
                    if (curve != null)
                    {
                        var ends = new[] { Position(curve.GetEndPoint(0)), Position(curve.GetEndPoint(1)) };
                        Array.Sort(ends, StringComparer.Ordinal);
                        // Midpoint distinguishes arcs that share endpoints but bow in opposite directions.
                        return "curve:" + curve.GetType().Name + ":" + string.Join(";", ends)
                            + ":" + Position(curve.Evaluate(0.5, true));
                    }
                }
                if (element is TextNote note) return "text:" + Position(note.Coord)
                    + ":base:" + Direction(note.BaseDirection)
                    + ":up:" + Direction(note.UpDirection);
                var box = element.get_BoundingBox(view) ?? element.get_BoundingBox(null);
                if (box == null) return null;
                var center = (box.Min + box.Max) * 0.5;
                var size = box.Max - box.Min;
                return "box:" + Position(center) + ":" + string.Join(",", new[] { size.X, size.Y, size.Z }
                    .Select(number => Math.Round(number, 4).ToString("F4", CultureInfo.InvariantCulture)));
            }
            catch { return null; }
        }

        private static object Point(XYZ point) => new { x = point.X, y = point.Y, z = point.Z };
    }
}
