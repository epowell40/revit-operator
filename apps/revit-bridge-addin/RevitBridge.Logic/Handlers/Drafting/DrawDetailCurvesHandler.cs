using System;
using System.Collections.Generic;
using System.Linq;
using System.Reflection;
using System.Text.Json;
using System.Threading.Tasks;
using Autodesk.Revit.DB;
using Autodesk.Revit.UI;
using RevitBridge.Common;

namespace RevitBridge.Logic.Handlers.Drafting
{
    public sealed class DrawDetailCurvesHandler : IRequestHandler
    {
        public sealed class CurveSpec
        {
            public string? kind { get; set; } // line|polyline|arc
            public DraftPoint? a { get; set; }
            public DraftPoint? b { get; set; }
            public DraftPoint? c { get; set; } // for arc: 3-point arc (start=a, end=b, pointOnArc=c)
            public List<DraftPoint>? points { get; set; } // for polyline
        }

        public sealed class Params
        {
            public long viewId { get; set; }
            public string? frameId { get; set; }
            public string? lineStyleName { get; set; }
            public LineStyleCreateSpec? lineStyleCreate { get; set; }
            public List<CurveSpec>? curves { get; set; }
            public bool? dryRun { get; set; }
        }

        public sealed class LineStyleCreateSpec
        {
            public string? name { get; set; }
            public int? lineWeight { get; set; }
            public int? r { get; set; }
            public int? g { get; set; }
            public int? b { get; set; }
            public string? linePatternName { get; set; }
        }

        public Task<object> Handle(UIApplication app, string jsonData)
        {
            var p = string.IsNullOrWhiteSpace(jsonData) ? new Params() : (JsonSerializer.Deserialize<Params>(jsonData) ?? new Params());
            var doc = app.ActiveUIDocument.Document;

            if (p.viewId <= 0) throw new InvalidOperationException("draw-detail-curves.viewId is required.");
            var view = doc.GetElement(RevitBridge.Common.ElementIdCompat.Create(p.viewId)) as View;
            if (view == null) throw new InvalidOperationException($"View {p.viewId} not found.");

            var curveSpecs = p.curves ?? new List<CurveSpec>();
            if (curveSpecs.Count == 0) throw new InvalidOperationException("draw-detail-curves.curves must be a non-empty array.");
            if (curveSpecs.Count > 2000) throw new InvalidOperationException("draw-detail-curves.curves too large (max 2000).");

            var dryRun = p.dryRun ?? false;
            var frameId = (p.frameId ?? "").Trim();

            // If frameId is provided, ensure it matches viewId to avoid accidental cross-view mapping.
            if (!string.IsNullOrWhiteSpace(frameId))
            {
                if (!FrameStore.TryGet(frameId, out var frame) || frame == null)
                    throw new InvalidOperationException($"Frame not found (expired?): {frameId}");
                if (frame.viewId != p.viewId)
                    throw new InvalidOperationException($"Frame {frameId} belongs to viewId={frame.viewId}, but request.viewId={p.viewId}.");
            }

            using (var t = new Transaction(doc, dryRun ? "Draw Detail Curves (dry run)" : "Draw Detail Curves"))
            {
                t.Start();

                var requestedStyleName = (p.lineStyleName ?? "").Trim();
                if (requestedStyleName.Length == 0)
                {
                    requestedStyleName = (p.lineStyleCreate?.name ?? "").Trim();
                }

                var styleCreated = false;
                var styleWarnings = new List<string>();
                var style = ResolveLineStyle(doc, requestedStyleName);
                if (style == null && p.lineStyleCreate != null)
                {
                    if (dryRun)
                    {
                        styleWarnings.Add($"Line style '{requestedStyleName}' will be created when dryRun=false.");
                    }
                    else
                    {
                        style = EnsureLineStyle(doc, p.lineStyleCreate, styleWarnings, out styleCreated);
                    }
                }

                var createdIds = new List<long>();
                var warnings = new List<string>();
                var segmentsCreated = 0;

                foreach (var cs in curveSpecs)
                {
                    var kind = (cs.kind ?? "").Trim().ToLowerInvariant();
                    if (kind == "line")
                    {
                        if (cs.a == null || cs.b == null) throw new InvalidOperationException("line requires a and b points.");
                        var a = cs.a.Resolve(frameId);
                        var b = cs.b.Resolve(frameId);
                        if (a.IsAlmostEqualTo(b)) { warnings.Add("Skipped zero-length line."); continue; }
                        var line = Line.CreateBound(a, b);
                        var dc = CreateDetailCurve(doc, view, line, style);
                        createdIds.Add(RevitBridge.Common.ElementIdCompat.GetValue(dc.Id));
                        segmentsCreated++;
                    }
                    else if (kind == "polyline")
                    {
                        var pts = cs.points ?? new List<DraftPoint>();
                        if (pts.Count < 2) throw new InvalidOperationException("polyline requires at least 2 points.");
                        if (pts.Count > 2000) throw new InvalidOperationException("polyline too large (max 2000 points).");

                        XYZ? prev = null;
                        for (int i = 0; i < pts.Count; i++)
                        {
                            var pxyz = pts[i].Resolve(frameId);
                            if (prev == null) { prev = pxyz; continue; }
                            if (prev.IsAlmostEqualTo(pxyz)) { prev = pxyz; continue; }
                            var seg = Line.CreateBound(prev, pxyz);
                            var dc = CreateDetailCurve(doc, view, seg, style);
                            createdIds.Add(RevitBridge.Common.ElementIdCompat.GetValue(dc.Id));
                            segmentsCreated++;
                            prev = pxyz;
                        }
                    }
                    else if (kind == "arc")
                    {
                        if (cs.a == null || cs.b == null || cs.c == null) throw new InvalidOperationException("arc requires a, b, c points.");
                        var a = cs.a.Resolve(frameId);
                        var b = cs.b.Resolve(frameId);
                        var c = cs.c.Resolve(frameId);
                        if (a.IsAlmostEqualTo(b)) throw new InvalidOperationException("arc start/end cannot be the same.");
                        var arc = Arc.Create(a, b, c);
                        var dc = CreateDetailCurve(doc, view, arc, style);
                        createdIds.Add(RevitBridge.Common.ElementIdCompat.GetValue(dc.Id));
                        segmentsCreated++;
                    }
                    else
                    {
                        throw new InvalidOperationException($"Unsupported curve kind: {cs.kind}");
                    }
                }

                if (dryRun)
                {
                    t.RollBack();
                    return Task.FromResult<object>(new
                    {
                        status = "Dry Run",
                        dryRun = true,
                        viewId = RevitBridge.Common.ElementIdCompat.GetValue(view.Id),
                        createdCount = createdIds.Count,
                        segmentsCreated,
                        lineStyle = new
                        {
                            requested = requestedStyleName.Length == 0 ? null : requestedStyleName,
                            createRequested = p.lineStyleCreate != null,
                            willCreate = p.lineStyleCreate != null && style == null,
                            warnings = styleWarnings
                        },
                        warnings = warnings.Concat(styleWarnings).ToArray()
                    });
                }

                t.Commit();
                return Task.FromResult<object>(new
                {
                    status = "Success",
                    dryRun = false,
                    viewId = RevitBridge.Common.ElementIdCompat.GetValue(view.Id),
                    detailCurveIds = createdIds,
                    createdCount = createdIds.Count,
                    segmentsCreated,
                    lineStyle = new
                    {
                        requested = requestedStyleName.Length == 0 ? null : requestedStyleName,
                        resolved = style?.GraphicsStyleCategory?.Name,
                        created = styleCreated
                    },
                    warnings = warnings.Concat(styleWarnings).ToArray()
                });
            }
        }

        private static GraphicsStyle? ResolveLineStyle(Document doc, string lineStyleName)
        {
            if (string.IsNullOrWhiteSpace(lineStyleName)) return null;
            try
            {
                var linesCat = doc.Settings.Categories.get_Item(BuiltInCategory.OST_Lines);
                if (linesCat == null) return null;
                foreach (Category sub in linesCat.SubCategories)
                {
                    if (sub == null) continue;
                    if (!string.Equals(sub.Name, lineStyleName, StringComparison.OrdinalIgnoreCase)) continue;
                    return sub.GetGraphicsStyle(GraphicsStyleType.Projection);
                }
            }
            catch
            {
                // ignore
            }
            return null;
        }

        private static GraphicsStyle? EnsureLineStyle(Document doc, LineStyleCreateSpec spec, List<string> warnings, out bool created)
        {
            created = false;
            var name = (spec.name ?? "").Trim();
            if (name.Length == 0) throw new InvalidOperationException("draw-detail-curves.lineStyleCreate.name is required.");

            var linesCat = doc.Settings.Categories.get_Item(BuiltInCategory.OST_Lines);
            if (linesCat == null) throw new InvalidOperationException("Unable to resolve OST_Lines category.");

            Category? sub = null;
            foreach (Category existing in linesCat.SubCategories)
            {
                if (existing == null) continue;
                if (string.Equals((existing.Name ?? "").Trim(), name, StringComparison.OrdinalIgnoreCase))
                {
                    sub = existing;
                    break;
                }
            }

            if (sub == null)
            {
                sub = doc.Settings.Categories.NewSubcategory(linesCat, name);
                created = true;
            }

            if (spec.lineWeight.HasValue)
            {
                var weight = spec.lineWeight.Value;
                if (weight < 1 || weight > 16)
                    throw new InvalidOperationException("draw-detail-curves.lineStyleCreate.lineWeight must be in range [1,16].");
                sub.SetLineWeight(weight, GraphicsStyleType.Projection);
            }

            if (spec.r.HasValue || spec.g.HasValue || spec.b.HasValue)
            {
                if (!(spec.r.HasValue && spec.g.HasValue && spec.b.HasValue))
                    throw new InvalidOperationException("draw-detail-curves.lineStyleCreate color requires r,g,b together.");
                if (!IsByte(spec.r.Value) || !IsByte(spec.g.Value) || !IsByte(spec.b.Value))
                    throw new InvalidOperationException("draw-detail-curves.lineStyleCreate color channels must be [0..255].");
                sub.LineColor = new Color((byte)spec.r.Value, (byte)spec.g.Value, (byte)spec.b.Value);
            }

            var patternName = (spec.linePatternName ?? "").Trim();
            if (patternName.Length > 0)
            {
                var pattern = new FilteredElementCollector(doc)
                    .OfClass(typeof(LinePatternElement))
                    .Cast<LinePatternElement>()
                    .FirstOrDefault(lp => string.Equals((lp.Name ?? "").Trim(), patternName, StringComparison.OrdinalIgnoreCase));
                if (pattern == null)
                {
                    warnings.Add($"Line pattern '{patternName}' was not found.");
                }
                else if (!TrySetLinePattern(sub, pattern.Id))
                {
                    warnings.Add($"Line pattern '{patternName}' could not be applied to line style '{name}' on this Revit version.");
                }
            }

            return sub.GetGraphicsStyle(GraphicsStyleType.Projection);
        }

        private static bool TrySetLinePattern(Category subCategory, ElementId patternId)
        {
            try
            {
                var method = subCategory.GetType().GetMethod("SetLinePatternId", BindingFlags.Public | BindingFlags.Instance, null, new[] { typeof(ElementId), typeof(GraphicsStyleType) }, null);
                if (method == null) return false;
                method.Invoke(subCategory, new object[] { patternId, GraphicsStyleType.Projection });
                return true;
            }
            catch
            {
                return false;
            }
        }

        private static bool IsByte(int value) => value >= 0 && value <= 255;

        private static DetailCurve CreateDetailCurve(Document doc, View view, Curve curve, GraphicsStyle? style)
        {
            var dc = doc.Create.NewDetailCurve(view, curve);
            if (style != null)
            {
                try { dc.LineStyle = style; } catch { /* ignore */ }
            }
            return dc;
        }
    }
}
