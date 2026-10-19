using System;
using System.Collections.Generic;
using System.Linq;
using System.Text.Json;
using Autodesk.Revit.DB;
using RevitBridge.Common;

namespace RevitBridge.Logic
{
    public sealed class VectorDraftingNativeRenderer
    {
        private readonly Document doc;
        private readonly ViewDrafting view;
        private readonly VectorDraftingStoredImport state;
        private readonly ISet<long> created;
        private readonly Dictionary<string, DrawingSpecNativeFontProfile> fonts;
        public VectorDraftingNativeRenderer(Document document, ViewDrafting target, VectorDraftingStoredImport owner, ISet<long> nativeCreated,
            Dictionary<string, DrawingSpecNativeFontProfile> installedFonts)
        { doc = document; view = target; state = owner; created = nativeCreated; fonts = installedFonts; if (!doc.IsModifiable) throw new InvalidOperationException("Missing owned vector transaction."); }
        public static Dictionary<string, DrawingSpecNativeFontProfile> Preflight(Document doc, VectorDraftingNativePlan plan)
        {
            VectorDraftingPlanCodec.Validate(plan);
            var result = plan.entities.Where(e => e.kind == "text").Select(e => e.font!).Distinct(StringComparer.OrdinalIgnoreCase)
                .ToDictionary(f => f, DrawingSpecNativeFontProfile.Capture, StringComparer.OrdinalIgnoreCase);
            foreach (var e in plan.entities)
            {
                void Check(string kind, double[][] points, string boundary)
                {
                    try
                    {
                        using var curve = Curve(kind, points, p => new XYZ(p[0] / 12 * plan.layout.viewScale, p[1] / 12 * plan.layout.viewScale, 0));
                        RequireCurveLength(curve, doc.Application.ShortCurveTolerance);
                    }
                    catch (Exception error)
                    {
                        throw new ArgumentException("Vector source entity '" + e.id + "' (source '" + e.sourceId + "', " + kind + boundary
                            + ") failed before transaction start; actual ShortCurveTolerance=" + doc.Application.ShortCurveTolerance.ToString("R", System.Globalization.CultureInfo.InvariantCulture)
                            + "ft. " + error.Message, error);
                    }
                }
                if (e.points != null) Check(e.kind, e.points, "");
                if (e.loops != null) for (int loop = 0; loop < e.loops.Length; loop++) for (int segment = 0; segment < e.loops[loop].Length; segment++)
                { var s = e.loops[loop][segment]; Check(s.kind, Controls(s), ", loop " + loop + " segment " + segment); }
                if (e.style != null && e.style.dashInches.Where((v, i) => i % 2 == 1).Any(v => v == 0)) throw new ArgumentException("Zero-length native dash gaps require explicit continuous-stroke conversion.");
            }
            return result;
        }
        public VectorDraftingOwnedPart Render(VectorDraftingNativePlan plan, int index)
        {
            var part = new VectorDraftingOwnedPart { Index = index };
            foreach (var e in plan.entities.Skip(index * plan.layout.partSize).Take(plan.layout.partSize))
            {
                Element native;
                if (e.kind == "line" || e.kind == "cubic_bezier")
                {
                    var curve = Curve(e.kind, e.points!, Point); native = doc.Create.NewDetailCurve(view, curve);
                    ApplyStroke(native.Id, e.style!);
                }
                else if (e.kind == "fill")
                {
                    var loops = e.loops!.Select(loop => CurveLoop.Create(loop.Select(s => Curve(s.kind, Controls(s), Point)).ToList())).ToList();
                    var fill = FilledRegion.Create(doc, FillType(e.fillColor!).Id, view.Id, loops); native = fill;
                    var invisible = FilledRegion.GetValidLineStyleIdsForFilledRegion(doc).Select(id => doc.GetElement(id) as GraphicsStyle)
                        .FirstOrDefault(style => style?.GraphicsStyleCategory?.BuiltInCategory == BuiltInCategory.OST_InvisibleLines)
                        ?? throw new InvalidOperationException("Native invisible filled-region boundary style is unavailable.");
                    fill.SetLineStyleId(invisible.Id);
                }
                else
                {
                    var options = new TextNoteOptions(TextType(e).Id) { HorizontalAlignment = HorizontalTextAlignment.Left,
                        VerticalAlignment = VerticalTextAlignment.Top, Rotation = e.rotation!.Value };
                    var note = TextNote.Create(doc, view.Id, Point(e.anchor!), e.text!, options); native = note;
                    using var formatting = note.GetFormattedText(); formatting.SetAllCapsStatus(false); note.SetFormattedText(formatting);
                }
                created.Add(ElementIdCompat.GetValue(native.Id));
                part.Entities.Add(new VectorDraftingOwnedEntity { Id = ElementIdCompat.GetValue(native.Id), UniqueId = native.UniqueId,
                    PlanEntityId = e.id, SourceId = e.sourceId, Kind = e.kind });
            }
            doc.Regenerate(); return part;
        }
        private XYZ Point(double[] p) => view.Origin + view.RightDirection * (p[0] / 12 * view.Scale) + view.UpDirection * (p[1] / 12 * view.Scale);
        internal static double[][] Controls(VectorDraftingNativeSegment s) => s.kind == "cubic_bezier"
            ? new[] { s.start, s.controlPoints![0], s.controlPoints[1], s.end } : new[] { s.start, s.end };
        internal static Autodesk.Revit.DB.Curve Curve(string kind, double[][] p, Func<double[], XYZ> point)
        {
            if (kind == "line" || kind == "close") return Line.CreateBound(point(p[0]), point(p[1]));
            if (kind == "cubic_bezier")
            {
                if (DraftingCubicBezier.IsExactMonotoneLine(p.Select(v => new[] { v[0], v[1], 0d }))) return Line.CreateBound(point(p[0]), point(p[3]));
                return NurbSpline.CreateCurve(3, DraftingCubicBezier.ClampedKnots(), p.Select(point).ToList());
            }
            throw new ArgumentException("Unknown source curve kind.");
        }
        private static void RequireCurveLength(Autodesk.Revit.DB.Curve curve, double tolerance) => DraftingCubicBezier.RequireNativeLength(curve.Length, tolerance);
        private void ApplyStroke(ElementId id, VectorDraftingNativeStyle style)
        {
            using var graphics = new OverrideGraphicSettings(); graphics.SetProjectionLineWeight(style.weight);
            graphics.SetProjectionLineColor(new Color((byte)style.color[0], (byte)style.color[1], (byte)style.color[2]));
            graphics.SetProjectionLinePatternId(LinePatternElement.GetSolidPatternId());
            if (style.dashInches.Length > 0)
            {
                var key = VectorDraftingPlanCodec.Hash(JsonSerializer.Serialize(style.dashInches));
                if (!state.LinePatterns.TryGetValue(key, out long patternId))
                {
                    var values = style.dashInches.Length % 2 == 0 ? style.dashInches : style.dashInches.Concat(style.dashInches).ToArray();
                    var pattern = new LinePattern("Operator Vector " + state.ImportKey.Substring(0, 8) + " " + key.Substring(0, 12));
                    pattern.SetSegments(values.Select((v, i) => new LinePatternSegment(i % 2 == 1 ? LinePatternSegmentType.Space : v == 0 ? LinePatternSegmentType.Dot : LinePatternSegmentType.Dash, v / 12)).ToList());
                    var element = LinePatternElement.Create(doc, pattern); patternId = ElementIdCompat.GetValue(element.Id); state.LinePatterns.Add(key, patternId); created.Add(patternId);
                }
                graphics.SetProjectionLinePatternId(ElementIdCompat.Create(patternId));
            }
            view.SetElementOverrides(id, graphics);
        }
        private TextNoteType TextType(VectorDraftingNativeEntity e)
        {
            var profile = fonts[e.font!]; var key = VectorDraftingPlanCodec.Hash(JsonSerializer.Serialize(new { e.font, e.emPoints, e.bold, e.italic, e.widthScale, profile.Signature }));
            if (state.TextTypes.TryGetValue(key, out long id)) return doc.GetElement(ElementIdCompat.Create(id)) as TextNoteType ?? throw new InvalidOperationException("Owned vector text type missing.");
            var original = doc.GetElement(doc.GetDefaultElementTypeId(ElementTypeGroup.TextNoteType)) as TextNoteType ?? throw new InvalidOperationException("No base text type.");
            var type = (TextNoteType)original.Duplicate("Operator Vector " + state.ImportKey.Substring(0, 8) + " " + key.Substring(0, 12));
            type.get_Parameter(BuiltInParameter.TEXT_FONT).Set(e.font); type.get_Parameter(BuiltInParameter.TEXT_SIZE).Set(profile.NativeSizeFeet(e.emPoints!.Value));
            type.get_Parameter(BuiltInParameter.TEXT_STYLE_BOLD).Set(e.bold == true ? 1 : 0); type.get_Parameter(BuiltInParameter.TEXT_STYLE_ITALIC).Set(e.italic == true ? 1 : 0);
            type.get_Parameter(BuiltInParameter.TEXT_STYLE_UNDERLINE).Set(0); type.get_Parameter(BuiltInParameter.TEXT_WIDTH_SCALE).Set(e.widthScale!.Value);
            type.get_Parameter(BuiltInParameter.TEXT_BACKGROUND).Set(1); type.get_Parameter(BuiltInParameter.LINE_COLOR)?.Set(0);
            id = ElementIdCompat.GetValue(type.Id); state.TextTypes.Add(key, id); created.Add(id); return type;
        }
        private FilledRegionType FillType(int[] rgb)
        {
            var key = string.Join("-", rgb); if (state.FillTypes.TryGetValue(key, out long id)) return doc.GetElement(ElementIdCompat.Create(id)) as FilledRegionType ?? throw new InvalidOperationException("Owned vector fill type missing.");
            var original = new FilteredElementCollector(doc).OfClass(typeof(FilledRegionType)).Cast<FilledRegionType>().OrderBy(t => ElementIdCompat.GetValue(t.Id)).FirstOrDefault()
                ?? throw new InvalidOperationException("No native filled-region type available.");
            var solid = new FilteredElementCollector(doc).OfClass(typeof(FillPatternElement)).Cast<FillPatternElement>().FirstOrDefault(p => p.GetFillPattern().IsSolidFill)
                ?? throw new InvalidOperationException("No native solid fill pattern.");
            var type = (FilledRegionType)original.Duplicate("Operator Vector " + state.ImportKey.Substring(0, 8) + " Fill " + key);
            type.IsMasking = true; type.ForegroundPatternId = solid.Id; type.ForegroundPatternColor = new Color((byte)rgb[0], (byte)rgb[1], (byte)rgb[2]);
            type.BackgroundPatternId = ElementId.InvalidElementId; id = ElementIdCompat.GetValue(type.Id); state.FillTypes.Add(key, id); created.Add(id); return type;
        }
    }
}
