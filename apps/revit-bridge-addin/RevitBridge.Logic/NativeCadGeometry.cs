using System;
using System.Collections.Generic;
using System.Linq;
using System.IO;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Autodesk.Revit.DB;
using RevitBridge.Common;

namespace RevitBridge.Logic
{
    /// <summary>Read actual imported geometry in host coordinates without exploding or editing it.</summary>
    public static class NativeCadGeometry
    {
        public sealed class Result
        {
            public string schema { get; set; } = "revit-operator.cad-geometry/v1";
            public long elementId { get; set; }
            public string uniqueId { get; set; } = "";
            public long ownerViewId { get; set; }
            public bool isLinked { get; set; }
            public string coordinateSpace { get; set; } = "host_model_feet";
            public bool complete { get; set; }
            public string[] issues { get; set; } = Array.Empty<string>();
            public int returnedCount { get; set; }
            public List<object> items { get; set; } = new List<object>();
            public PageInfo? page { get; set; }
        }
        public sealed class PageInfo
        {
            public string schema { get; set; } = "revit-operator.cad-geometry-page/v1";
            public int offset { get; set; }
            public int totalPrimitiveCount { get; set; }
            public int? nextOffset { get; set; }
            public bool complete { get; set; }
            public string? completeGeometrySnapshotSha256 { get; set; }
        }
        /// <summary>Explicit single-import paging, with a digest of every complete
        /// native primitive on every page. A page never asserts whole-import coverage.</summary>
        public static Result ReadPage(ImportInstance imported, View view, CadGeometryReadBudget budget, int offset)
        {
            var page = new CadGeometryPageWindow(offset, budget);
            var items = new List<object>(); var issues = new HashSet<string>(StringComparer.Ordinal); int visited = 0;
            using var sha = SHA256.Create();
            using var stream = new CryptoStream(Stream.Null, sha, CryptoStreamMode.Write);
            void Hash(object value)
            {
                var bytes = Encoding.UTF8.GetBytes(JsonSerializer.Serialize(value));
                stream.Write(bytes, 0, bytes.Length); stream.WriteByte(10);
            }
            Hash(new { schema = "revit-operator.complete-cad-native-geometry/v1", elementId = ElementIdCompat.GetValue(imported.Id),
                imported.UniqueId, ownerViewId = ElementIdCompat.GetValue(imported.OwnerViewId), imported.IsLinked });
            void Visit(GeometryElement geometry, Transform transform, int depth)
            {
                if (depth > CadGeometryReadBudget.MaximumDepth) throw new InvalidOperationException("depth_limit");
                foreach (var item in geometry)
                {
                    if (++visited > 40000) throw new InvalidOperationException("traversal_limit");
                    if (item is GeometryInstance instance)
                    {
                        var child = instance.GetSymbolGeometry();
                        if (child == null) throw new InvalidOperationException("missing_symbol_geometry");
                        Visit(child, transform.Multiply(instance.Transform), depth + 1);
                        continue;
                    }
                    object record; int cost;
                    if (item is PolyLine polyline)
                    {
                        var points = polyline.GetCoordinates();
                        if (points.Count < 2 || points.Count > 1000) throw new InvalidOperationException("unsupported_polyline_size");
                        cost = points.Count;
                        record = new { kind = "PolyLine", points = points.Select(p => Point(transform.OfPoint(p))).ToArray(),
                            layerName = LayerName(view.Document, item), graphicsStyleId = ElementIdCompat.GetValue(item.GraphicsStyleId) };
                    }
                    else if (item is Curve curve)
                    {
                        cost = curve is NurbSpline spline
                            ? (int)Math.Min(1001L, (long)spline.CtrlPoints.Count + spline.Knots.Size + spline.Weights.Size) : 1;
                        if (cost < 1 || cost > 1000) throw new InvalidOperationException("unsupported_curve_size");
                        using var transformed = curve.CreateTransformed(transform);
                        record = new { kind = "Curve", geometry = NativeDraftingCurveGeometry.Read(transformed),
                            layerName = LayerName(view.Document, item), graphicsStyleId = ElementIdCompat.GetValue(item.GraphicsStyleId) };
                    }
                    else throw new InvalidOperationException("unsupported_geometry:" + item.GetType().Name);
                    bool include = page.Observe(cost);
                    Hash(record); // All native primitives, including preceding/following pages.
                    if (include) items.Add(record);
                }
            }
            try
            {
                if (imported.OwnerViewId != view.Id) throw new InvalidOperationException("owner_view_mismatch");
                using var options = new Options { View = view };
                var geometry = imported.get_Geometry(options);
                if (geometry == null) throw new InvalidOperationException("missing_import_geometry");
                Visit(geometry, Transform.Identity, 0);
                if (!page.IsValidCompletePage) issues.Add("offset_or_complete_primitive_budget_invalid");
                if (page.TotalCount == 0) issues.Add("empty_import_geometry");
            }
            catch (Exception error) { issues.Add("complete_native_geometry_read_failed:" + error.Message); }
            stream.FlushFinalBlock();
            var completePage = issues.Count == 0;
            return new Result { elementId = ElementIdCompat.GetValue(imported.Id), uniqueId = imported.UniqueId,
                ownerViewId = ElementIdCompat.GetValue(imported.OwnerViewId), isLinked = imported.IsLinked,
                complete = completePage && offset == 0 && !page.NextOffset.HasValue,
                returnedCount = items.Count, items = items, issues = issues.OrderBy(v => v, StringComparer.Ordinal).ToArray(),
                page = new PageInfo { offset = offset, totalPrimitiveCount = page.TotalCount, nextOffset = page.NextOffset,
                    complete = completePage, completeGeometrySnapshotSha256 = completePage
                        ? BitConverter.ToString(sha.Hash!).Replace("-", "").ToLowerInvariant() : null } };
        }
        public static Result Read(ImportInstance imported, View view, CadGeometryReadBudget budget)
        {
            var items = new List<object>();
            var issues = new HashSet<string>(StringComparer.Ordinal);
            var visited = 0;
            void Visit(GeometryElement geometry, Transform transform, int depth)
            {
                if (depth > CadGeometryReadBudget.MaximumDepth) { issues.Add("depth_limit"); return; }
                foreach (var item in geometry)
                {
                    // Bound traversal as well as output, including empty/nested instances.
                    if (++visited > 2000) { issues.Add("traversal_limit"); return; }
                    if (budget.Remaining == 0) { issues.Add("response_geometry_limit"); return; }
                    if (item is GeometryInstance instance)
                    {
                        var child = instance.GetSymbolGeometry();
                        if (child == null) { issues.Add("missing_symbol_geometry"); continue; }
                        Visit(child, transform.Multiply(instance.Transform), depth + 1);
                    }
                    else if (item is PolyLine polyline)
                    {
                        var points = polyline.GetCoordinates();
                        if (points.Count < 2) { issues.Add("degenerate_polyline"); continue; }
                        if (!budget.TryConsume(points.Count)) { issues.Add("response_geometry_limit"); continue; }
                        items.Add(new { kind = "PolyLine", points = points.Select(p => Point(transform.OfPoint(p))).ToArray(),
                            layerName = LayerName(view.Document, item),
                            graphicsStyleId = ElementIdCompat.GetValue(item.GraphicsStyleId) });
                    }
                    else if (item is Curve curve)
                    {
                        var cost = curve is NurbSpline spline
                            ? (int)Math.Min(1001L, (long)spline.CtrlPoints.Count + spline.Knots.Size + spline.Weights.Size) : 1;
                        if (!budget.TryConsume(cost)) { issues.Add("response_geometry_limit"); continue; }
                        try
                        {
                            using (var transformed = curve.CreateTransformed(transform))
                                items.Add(new { kind = "Curve", geometry = NativeDraftingCurveGeometry.Read(transformed),
                                    layerName = LayerName(view.Document, item),
                                    graphicsStyleId = ElementIdCompat.GetValue(item.GraphicsStyleId) });
                        }
                        catch { issues.Add("unsupported_or_unreadable_curve"); }
                    }
                    else issues.Add("unsupported_geometry:" + item.GetType().Name);
                }
            }
            try
            {
                using (var options = new Options { View = view })
                {
                    var geometry = imported.get_Geometry(options);
                    if (geometry == null) issues.Add("missing_import_geometry");
                    else Visit(geometry, Transform.Identity, 0);
                }
            }
            catch { issues.Add("native_geometry_read_failed"); }
            return new Result { elementId = ElementIdCompat.GetValue(imported.Id),
                uniqueId = imported.UniqueId, ownerViewId = ElementIdCompat.GetValue(imported.OwnerViewId),
                isLinked = imported.IsLinked, coordinateSpace = "host_model_feet", complete = issues.Count == 0 && items.Count > 0,
                issues = issues.OrderBy(x => x, StringComparer.Ordinal).ToArray(), returnedCount = items.Count, items = items };
        }
        private static object Point(XYZ p) => new { x = p.X, y = p.Y, z = p.Z };
        private static string? LayerName(Document doc, GeometryObject item)
            => (doc.GetElement(item.GraphicsStyleId) as GraphicsStyle)?.GraphicsStyleCategory?.Name;
    }
}
