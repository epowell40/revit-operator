using System;
using System.Collections.Generic;
using System.Linq;
using Autodesk.Revit.DB;
using RevitBridge.Common;

namespace RevitBridge.Logic
{
    // Read-only check against retained source-plan controls/text/styles. It neither re-extracts
    // the original PDF nor certifies visual fidelity. The backend must bind those separate proofs.
    public static class VectorDraftingNativeProjection
    {
        public static object Check(Document doc, VectorDraftingStoredImport state, VectorDraftingOwnedPart part)
        {
            var plan = VectorDraftingImportState.Plan(state); var view = VectorDraftingImportState.View(doc, state);
            var expected = plan.entities.Skip(part.Index * plan.layout.partSize).Take(plan.layout.partSize).ToArray();
            var issues = new List<object>(); int issueCount = 0, inspected = 0, simplifiedCubics = 0;
            void Issue(string sourceId, string reason) { issueCount++; if (issues.Count < 100) issues.Add(new { sourceId, reason }); }
            XYZ Point(double[] p) => view.Origin + view.RightDirection * (p[0] / 12 * view.Scale) + view.UpDirection * (p[1] / 12 * view.Scale);
            var fonts = new Dictionary<string, DrawingSpecNativeFontProfile>(StringComparer.OrdinalIgnoreCase);
            if (expected.Length != part.Entities.Count) Issue("part", "Complete owned source/native entity count differs.");
            if (part.Entities.Select(e => e.Id).Distinct().Count() != part.Entities.Count) Issue("part", "Duplicate native identities cannot fulfill distinct source entities.");
            for (int i = 0; i < expected.Length; i++)
            {
                var source = expected[i];
                try
                {
                    if (i >= part.Entities.Count) { Issue(source.id, "Source entity has no owned native element."); continue; }
                    var owned = part.Entities[i]; var native = doc.GetElement(ElementIdCompat.Create(owned.Id));
                    if (source.id != owned.PlanEntityId || source.sourceId != owned.SourceId || source.kind != owned.Kind || native == null
                        || native.UniqueId != owned.UniqueId || ElementIdCompat.GetValue(native.OwnerViewId) != state.ViewId)
                    { Issue(source.id, "Source/native identity, order, kind or view differs."); continue; }
                    inspected++;
                    if (source.kind == "line" || source.kind == "cubic_bezier")
                    {
                        if (!(native is DetailCurve detail)) { Issue(source.id, "Owned source stroke is not a native detail curve."); continue; }
                        using var projected = VectorDraftingNativeRenderer.Curve(source.kind, source.points!, Point);
                        if (source.kind == "cubic_bezier" && !(projected is NurbSpline)) simplifiedCubics++;
                        if (CurveKey(projected) != CurveKey(detail.GeometryCurve)) Issue(source.id, "Complete native curve controls/knots/weights/domain differ from native source projection.");
                        using var graphics = view.GetElementOverrides(native.Id); var color = graphics.ProjectionLineColor; var style = source.style!;
                        if (graphics.ProjectionLineWeight != style.weight || !SameColor(color, style.color)) Issue(source.id, "Native stroke pen/color differs.");
                        if (style.dashInches.Length == 0)
                        { if (graphics.ProjectionLinePatternId != LinePatternElement.GetSolidPatternId()) Issue(source.id, "Native solid stroke pattern differs."); }
                        else
                        {
                            var pattern = doc.GetElement(graphics.ProjectionLinePatternId) as LinePatternElement;
                            var actual = pattern?.GetLinePattern().GetSegments();
                            var values = style.dashInches.Length % 2 == 0 ? style.dashInches : style.dashInches.Concat(style.dashInches).ToArray();
                            if (actual == null || actual.Count != values.Length || values.Where((v, n) => actual[n].Type !=
                                    (n % 2 == 1 ? LinePatternSegmentType.Space : v == 0 ? LinePatternSegmentType.Dot : LinePatternSegmentType.Dash)
                                    || Math.Abs(actual[n].Length - v / 12) > 1e-9).Any()) Issue(source.id, "Complete native dash pattern differs.");
                        }
                    }
                    else if (source.kind == "fill")
                    {
                        if (!(native is FilledRegion region)) { Issue(source.id, "Source fill is not a native filled region."); continue; }
                        var wanted = source.loops!.Select(loop => LoopKey(loop.Select(s => VectorDraftingNativeRenderer.Curve(s.kind, VectorDraftingNativeRenderer.Controls(s), Point))))
                            .OrderBy(v => v, StringComparer.Ordinal).ToArray();
                        var observed = region.GetBoundaries().Select(loop => LoopKey(loop)).OrderBy(v => v, StringComparer.Ordinal).ToArray();
                        if (!wanted.SequenceEqual(observed)) Issue(source.id, "Complete native fill boundaries/holes differ.");
                        var type = doc.GetElement(region.GetTypeId()) as FilledRegionType;
                        var pattern = type == null ? null : doc.GetElement(type.ForegroundPatternId) as FillPatternElement;
                        if (type == null || !type.IsMasking || pattern == null || !pattern.GetFillPattern().IsSolidFill
                            || !SameColor(type.ForegroundPatternColor, source.fillColor!)) Issue(source.id, "Native solid fill color/masking differs.");
                    }
                    else
                    {
                        if (!(native is TextNote note)) { Issue(source.id, "Source text is not an editable native text note."); continue; }
                        var type = note.TextNoteType;
                        if (!fonts.TryGetValue(source.font!, out var font)) { font = DrawingSpecNativeFontProfile.Capture(source.font!); fonts.Add(source.font!, font); }
                        if (note.Text != source.text && note.Text != source.text + "\r") Issue(source.id, "Full native text differs from source.");
                        var direction = view.RightDirection * Math.Cos(source.rotation!.Value) + view.UpDirection * Math.Sin(source.rotation.Value);
                        if (note.Coord.DistanceTo(Point(source.anchor!)) > 1e-7 || note.BaseDirection.DistanceTo(direction) > 1e-8) Issue(source.id, "Native text anchor/baseline differs.");
                        if (!string.Equals(type.get_Parameter(BuiltInParameter.TEXT_FONT).AsString(), source.font, StringComparison.OrdinalIgnoreCase)
                            || Math.Abs(type.get_Parameter(BuiltInParameter.TEXT_SIZE).AsDouble() - font.NativeSizeFeet(source.emPoints!.Value)) > 1e-9
                            || Math.Abs(type.get_Parameter(BuiltInParameter.TEXT_WIDTH_SCALE).AsDouble() - source.widthScale!.Value) > 1e-9
                            || type.get_Parameter(BuiltInParameter.TEXT_STYLE_BOLD).AsInteger() != (source.bold == true ? 1 : 0)
                            || type.get_Parameter(BuiltInParameter.TEXT_STYLE_ITALIC).AsInteger() != (source.italic == true ? 1 : 0)
                            || type.get_Parameter(BuiltInParameter.TEXT_STYLE_UNDERLINE).AsInteger() != 0
                            || type.get_Parameter(BuiltInParameter.TEXT_BACKGROUND).AsInteger() != 1 || type.get_Parameter(BuiltInParameter.LINE_COLOR).AsInteger() != 0)
                            Issue(source.id, "Native text type/font/em calibration/style differs.");
                    }
                }
                catch (Exception error) { Issue(source.id, "Native source projection could not be checked: " + error.Message); }
            }
            return new { schema = "operator.vector-drafting-native-projection.v1", completePartRead = inspected == expected.Length && part.Entities.Count == expected.Length,
                sourceNativeProjectionMatches = issueCount == 0, sourceEntityCount = expected.Length, nativeEntitiesInspected = inspected,
                issueCount, issues, issueListTruncated = issueCount > issues.Count, nativeKernelSimplifiedCubicCount = simplifiedCubics,
                sourceGeometryIndependentlyReparsed = false, visualVerified = false,
                limits = new[] { "Comparison is against the retained native source plan, not a fresh independent PDF extraction.",
                    "Curve checks use complete native representations including cubic controls/knots/weights/domain, never just endpoints/midpoint. Native kernel simplification is explicitly counted.",
                    "Text glyph widths, paint order, source text clipping/color/decorations, boundary appearance and sheet layout require integral visual comparison; a passing part is not a whole-task verdict." } };
        }
        private static string CurveKey(Curve curve)
        {
            string forward = VectorDraftingImportState.CanonicalHash(NativeDraftingCurveGeometry.Read(curve));
            using var reversed = curve.CreateReversed(); string backward = VectorDraftingImportState.CanonicalHash(NativeDraftingCurveGeometry.Read(reversed));
            return string.CompareOrdinal(forward, backward) <= 0 ? forward : backward;
        }
        private static string LoopKey(IEnumerable<Curve> curves) => VectorDraftingPlanCodec.Hash(string.Join(";", curves.Select(CurveKey).OrderBy(v => v, StringComparer.Ordinal)));
        private static bool SameColor(Color color, int[] rgb) => color.IsValid && color.Red == rgb[0] && color.Green == rgb[1] && color.Blue == rgb[2];
    }
}
