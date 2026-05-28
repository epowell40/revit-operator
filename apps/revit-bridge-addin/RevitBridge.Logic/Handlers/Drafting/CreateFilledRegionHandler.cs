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
    public sealed class CreateFilledRegionHandler : IRequestHandler
    {
        public sealed class LoopSpec
        {
            public List<DraftPoint>? points { get; set; }
        }

        public sealed class Params
        {
            public string? action { get; set; } // create|list_types|create_type
            public long viewId { get; set; }
            public string? frameId { get; set; }
            public string? typeName { get; set; }
            public long? typeId { get; set; }
            public string? newTypeName { get; set; } // create_type
            public long? sourceTypeId { get; set; } // create_type
            public string? sourceTypeName { get; set; } // create_type
            public string? fillPatternName { get; set; } // create_type
            public bool? allowExisting { get; set; } // create_type
            public List<LoopSpec>? loops { get; set; }
            public bool? dryRun { get; set; }
        }

        public Task<object> Handle(UIApplication app, string jsonData)
        {
            var p = string.IsNullOrWhiteSpace(jsonData) ? new Params() : (JsonSerializer.Deserialize<Params>(jsonData) ?? new Params());
            var doc = app.ActiveUIDocument.Document;
            var action = (p.action ?? "create").Trim().ToLowerInvariant();

            if (action == "list_types")
            {
                var items = new FilteredElementCollector(doc)
                    .OfClass(typeof(FilledRegionType))
                    .Cast<FilledRegionType>()
                    .Select(t => new
                    {
                        id = RevitBridge.Common.ElementIdCompat.GetValue(t.Id),
                        name = t.Name,
                        fillPatternName = TryGetFillPatternName(doc, t)
                    })
                    .OrderBy(x => x.name, StringComparer.OrdinalIgnoreCase)
                    .ThenBy(x => x.id)
                    .ToArray();

                return Task.FromResult<object>(new
                {
                    status = "Success",
                    action = "list_types",
                    count = items.Length,
                    types = items
                });
            }

            if (action == "create_type")
            {
                var newTypeName = (p.newTypeName ?? "").Trim();
                if (newTypeName.Length == 0)
                    throw new InvalidOperationException("create-filled-region.create_type requires newTypeName.");

                var allowExisting = p.allowExisting ?? true;
                var existing = ResolveTypeByName(doc, newTypeName);
                if (existing != null && !allowExisting)
                    throw new InvalidOperationException($"Filled region type '{newTypeName}' already exists.");

                var source = ResolveFilledRegionType(doc, p.sourceTypeId, p.sourceTypeName) ?? ResolveFallbackType(doc);
                if (source == null)
                    throw new InvalidOperationException("No FilledRegionType found in project.");

                var dryRunCreateType = p.dryRun ?? false;
                var shouldCreate = existing == null;

                if (dryRunCreateType)
                {
                    return Task.FromResult<object>(new
                    {
                        status = "Dry Run",
                        action = "create_type",
                        dryRun = true,
                        type = new
                        {
                            name = newTypeName,
                            willCreate = shouldCreate,
                            allowExisting,
                            sourceType = new { id = RevitBridge.Common.ElementIdCompat.GetValue(source.Id), name = source.Name },
                            fillPatternName = p.fillPatternName
                        }
                    });
                }

                FilledRegionType target;
                using (var txType = new Transaction(doc, "Create Filled Region Type"))
                {
                    txType.Start();
                    if (shouldCreate)
                    {
                        target = source.Duplicate(newTypeName) as FilledRegionType
                                 ?? throw new InvalidOperationException("Failed to create filled region type.");
                    }
                    else
                    {
                        target = existing!;
                    }

                    var fillPatternName = (p.fillPatternName ?? "").Trim();
                    if (fillPatternName.Length > 0)
                    {
                        var fillPatternId = ResolveFillPatternId(doc, fillPatternName);
                        if (fillPatternId == ElementId.InvalidElementId)
                            throw new InvalidOperationException($"Fill pattern '{fillPatternName}' not found.");
                        if (!TrySetFillPattern(target, fillPatternId))
                            throw new InvalidOperationException("Unable to set fill pattern on filled region type.");
                    }
                    txType.Commit();
                }

                return Task.FromResult<object>(new
                {
                    status = "Success",
                    action = "create_type",
                    type = new
                    {
                        id = RevitBridge.Common.ElementIdCompat.GetValue(target.Id),
                        name = target.Name,
                        created = shouldCreate,
                        fillPatternName = TryGetFillPatternName(doc, target)
                    }
                });
            }

            if (p.viewId <= 0) throw new InvalidOperationException("create-filled-region.viewId is required.");
            var view = doc.GetElement(RevitBridge.Common.ElementIdCompat.Create(p.viewId)) as View;
            if (view == null) throw new InvalidOperationException($"View {p.viewId} not found.");

            var loops = p.loops ?? new List<LoopSpec>();
            if (loops.Count == 0) throw new InvalidOperationException("create-filled-region.loops must be a non-empty array.");
            if (loops.Count > 50) throw new InvalidOperationException("create-filled-region.loops too large (max 50).");

            var dryRun = p.dryRun ?? false;
            var frameId = (p.frameId ?? "").Trim();

            if (!string.IsNullOrWhiteSpace(frameId))
            {
                if (!FrameStore.TryGet(frameId, out var frame) || frame == null)
                    throw new InvalidOperationException($"Frame not found (expired?): {frameId}");
                if (frame.viewId != p.viewId)
                    throw new InvalidOperationException($"Frame {frameId} belongs to viewId={frame.viewId}, but request.viewId={p.viewId}.");
            }

            using (var t = new Transaction(doc, dryRun ? "Create Filled Region (dry run)" : "Create Filled Region"))
            {
                t.Start();

                var type = ResolveFilledRegionType(doc, p.typeId, p.typeName) ?? ResolveFallbackType(doc);
                if (type == null) throw new InvalidOperationException("No filled region type found.");
                var typeId = type.Id;
                var curveLoops = new List<CurveLoop>();
                foreach (var l in loops)
                {
                    var pts = l.points ?? new List<DraftPoint>();
                    if (pts.Count < 3) throw new InvalidOperationException("Each loop must have at least 3 points.");
                    if (pts.Count > 2000) throw new InvalidOperationException("Loop too large (max 2000 points).");

                    var xyz = pts.Select(pp => pp.Resolve(frameId)).ToList();
                    // Close loop if needed.
                    if (!xyz[0].IsAlmostEqualTo(xyz[xyz.Count - 1]))
                        xyz.Add(xyz[0]);

                    var cl = new CurveLoop();
                    for (int i = 0; i < xyz.Count - 1; i++)
                    {
                        var a = xyz[i];
                        var b = xyz[i + 1];
                        if (a.IsAlmostEqualTo(b)) continue;
                        cl.Append(Line.CreateBound(a, b));
                    }

                    if (cl.Count() < 3) throw new InvalidOperationException("Loop does not contain enough non-degenerate segments.");
                    curveLoops.Add(cl);
                }

                var fr = FilledRegion.Create(doc, typeId, view.Id, curveLoops);

                if (dryRun)
                {
                    t.RollBack();
                    return Task.FromResult<object>(new
                    {
                        status = "Dry Run",
                        dryRun = true,
                        viewId = RevitBridge.Common.ElementIdCompat.GetValue(view.Id),
                        type = new { id = RevitBridge.Common.ElementIdCompat.GetValue(type.Id), name = type.Name },
                        loops = curveLoops.Count
                    });
                }

                t.Commit();
                return Task.FromResult<object>(new
                {
                    status = "Success",
                    dryRun = false,
                    viewId = RevitBridge.Common.ElementIdCompat.GetValue(view.Id),
                    type = new { id = RevitBridge.Common.ElementIdCompat.GetValue(type.Id), name = type.Name },
                    filledRegionId = RevitBridge.Common.ElementIdCompat.GetValue(fr.Id),
                    loops = curveLoops.Count
                });
            }
        }

        private static FilledRegionType? ResolveFilledRegionType(Document doc, long? typeId, string? typeName)
        {
            if (typeId.HasValue && typeId.Value > 0)
            {
                return doc.GetElement(RevitBridge.Common.ElementIdCompat.Create(typeId.Value)) as FilledRegionType;
            }

            var name = (typeName ?? "").Trim();
            if (name.Length == 0) return null;

            return ResolveTypeByName(doc, name);
        }

        private static FilledRegionType? ResolveTypeByName(Document doc, string name)
        {
            return new FilteredElementCollector(doc)
                .OfClass(typeof(FilledRegionType))
                .Cast<FilledRegionType>()
                .FirstOrDefault(t => t != null && string.Equals((t.Name ?? "").Trim(), name, StringComparison.OrdinalIgnoreCase));
        }

        private static FilledRegionType? ResolveFallbackType(Document doc)
        {
            var id = new FilteredElementCollector(doc).OfClass(typeof(FilledRegionType)).FirstElementId();
            if (id == null || id == ElementId.InvalidElementId) return null;
            return doc.GetElement(id) as FilledRegionType;
        }

        private static ElementId ResolveFillPatternId(Document doc, string patternName)
        {
            var pattern = new FilteredElementCollector(doc)
                .OfClass(typeof(FillPatternElement))
                .Cast<FillPatternElement>()
                .FirstOrDefault(fp => string.Equals((fp.Name ?? "").Trim(), patternName, StringComparison.OrdinalIgnoreCase));
            return pattern?.Id ?? ElementId.InvalidElementId;
        }

        private static bool TrySetFillPattern(FilledRegionType type, ElementId patternId)
        {
            if (patternId == null || patternId == ElementId.InvalidElementId) return false;
            return TrySetElementIdProperty(type, "ForegroundPatternId", patternId) ||
                   TrySetElementIdProperty(type, "FillPatternId", patternId);
        }

        private static string? TryGetFillPatternName(Document doc, FilledRegionType type)
        {
            var pid = TryGetElementIdProperty(type, "ForegroundPatternId") ??
                      TryGetElementIdProperty(type, "FillPatternId");
            if (pid == null || pid == ElementId.InvalidElementId) return null;
            return doc.GetElement(pid)?.Name;
        }

        private static bool TrySetElementIdProperty(object target, string propName, ElementId value)
        {
            try
            {
                var p = target.GetType().GetProperty(propName, BindingFlags.Instance | BindingFlags.Public);
                if (p == null || !p.CanWrite || p.PropertyType != typeof(ElementId)) return false;
                p.SetValue(target, value, null);
                return true;
            }
            catch
            {
                return false;
            }
        }

        private static ElementId? TryGetElementIdProperty(object target, string propName)
        {
            try
            {
                var p = target.GetType().GetProperty(propName, BindingFlags.Instance | BindingFlags.Public);
                if (p == null || !p.CanRead || p.PropertyType != typeof(ElementId)) return null;
                return p.GetValue(target, null) as ElementId;
            }
            catch
            {
                return null;
            }
        }
    }
}
