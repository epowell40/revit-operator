using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Linq;
using Autodesk.Revit.DB;
using Autodesk.Revit.UI;
using RevitBridge.Common;
using RevitBridge.Logic.Handlers.DynamicRuntime;

namespace RevitBridge.Logic
{
    public static class NativeProgramEffectObservation
    {
        internal static object Read(Document doc, IEnumerable<long> ids, Func<string, OperatorDocumentChangeVersion>? version = null)
        {
            var clock=Stopwatch.StartNew();
            return OperatorNativeEffectState.Observe(Fingerprint(doc), OperatorNativeDocumentSessionAuthority.GetSessionId(doc), ids,
                id=>clock.ElapsedMilliseconds>5000 ? OperatorNativeEffectState.Unavailable(id,"native_state_time_budget_exhausted") : ReadItem(doc,id), version);
        }
        private static string Fingerprint(Document doc)
        {
            string? uid=null;try{uid=doc.ProjectInformation?.UniqueId;}catch{}
            return "sha256:"+OperatorRevitBatchBinding.ComputeProjectFingerprint(doc.Title,doc.PathName,uid);
        }

        // Called after native settlement. Observation failure must NEVER turn a committed
        // write into no-effect/rollback, remove its audit or authorize another execution.
        public static void AttachCommitted(UIApplication app, Dictionary<string, object?> result)
            => AttachCommitted(app, result, null);
        public static void AttachCommitted(UIApplication app, Dictionary<string, object?> result, Func<string, OperatorDocumentChangeVersion>? version)
        {
            OperatorNativeEffectState.AttachAfterCommit(result,ids=>Read(app.ActiveUIDocument.Document,ids,version));
        }
        private static OperatorNativeEffectState.Item ReadItem(Document doc, long id)
        {
            var e = doc.GetElement(ElementIdCompat.Create(id));
            if (e == null) return OperatorNativeEffectState.Capture(id, false, new { elementId = id, found = false });
            object shape;
            if (e is CurveElement curve)
                shape = new { kind = "drafting_curve", geometry = NativeDraftingCurveGeometry.Read(curve.GeometryCurve),
                    style = curve.LineStyle is GraphicsStyle style ? Style(style) : throw new InvalidOperationException("Missing line style.") };
            else if (e is TextNote text)
            {
                if (text.Text.Length > 4096 || text.LeaderCount > 256) throw new InvalidOperationException("Native text observation capacity exceeded.");
                using var formatted = text.GetFormattedText();
                // Exact character formatting; no plaintext-only claim for rich notes.
                var formatting = Enumerable.Range(0, formatted.GetPlainText().Length).Select(i => {
                    var range = new TextRange(i, 1);
                    return string.Join(",", formatted.GetBoldStatus(range), formatted.GetItalicStatus(range),
                        formatted.GetUnderlineStatus(range), formatted.GetAllCapsStatus(range),
                        formatted.GetSuperscriptStatus(range), formatted.GetSubscriptStatus(range));
                }).ToArray();
                shape = new { kind = "text_note", text = text.Text, plainText = formatted.GetPlainText(), formatting,
                    coord = Point(text.Coord), baseDirection = Point(text.BaseDirection), upDirection = Point(text.UpDirection),
                    width = text.Width, height = text.Height, horizontalAlignment = text.HorizontalAlignment.ToString(),
                    verticalAlignment = text.VerticalAlignment.ToString(), leftAttachment = text.LeaderLeftAttachment.ToString(),
                    rightAttachment = text.LeaderRightAttachment.ToString(),
                    leaders = text.GetLeaders().Select(l => new { shape = l.LeaderShape.ToString(), anchor = Point(l.Anchor), elbow = Point(l.Elbow), end = Point(l.End) }).ToArray(),
                    textType = Parameters(text.TextNoteType) };
            }
            else if (e is TextNoteType) shape = new { kind = "text_note_type_parameters" };
            else if (e is FilledRegion region)
            {
                var regionType = doc.GetElement(region.GetTypeId()) as FilledRegionType
                    ?? throw new InvalidOperationException("Native filled region has no readable type.");
                shape = new { kind = "filled_region", boundaries = Loops(region.GetBoundaries().Select(loop => loop.Cast<Curve>())),
                    regionType = RegionType(regionType), typeParameters = Parameters(regionType) };
            }
            else if (e is FilledRegionType regionDefinition) shape = RegionType(regionDefinition);
            else if (e is FillPatternElement fillPattern) shape = Fill(fillPattern);
            else if (e is Sketch sketch)
                shape = new { kind = "sketch", profile = Loops(sketch.Profile.Cast<CurveArray>().Select(loop => loop.Cast<Curve>())),
                    plane = sketch.SketchPlane == null ? null : Plane(sketch.SketchPlane.GetPlane()),
                    memberIds = Bound(sketch.GetAllElements().Select(ElementIdCompat.GetValue),4096).OrderBy(n=>n).ToArray() };
            else if (e.GetType() == typeof(Dimension)) shape = DimensionState((Dimension)e);
            else if (e is GraphicsStyle graphics) shape = Style(graphics);
            else if (e is LinePatternElement pattern)
                shape = new { kind = "line_pattern", segments = pattern.GetLinePattern().GetSegments().Select(s => new { type = s.Type.ToString(), length = s.Length }).ToArray() };
            else if (e is SketchPlane plane)
                shape = new { kind = "sketch_plane", origin = Point(plane.GetPlane().Origin), normal = Point(plane.GetPlane().Normal),
                    x = Point(plane.GetPlane().XVec), y = Point(plane.GetPlane().YVec) };
            else if (e is ViewDrafting view)
                shape = new { kind = "drafting_view", scale = view.Scale, origin = Point(view.Origin),
                    right = Point(view.RightDirection), up = Point(view.UpDirection), direction = Point(view.ViewDirection) };
            else if (e.GetType() == typeof(Element) && e.Name == "ExtentElem")
                shape = new { kind = "view_extent_infrastructure", box = Box(e) };
            else if (e.GetType() == typeof(Element) && e.Category == null && e.GetTypeId() == ElementId.InvalidElementId &&
                e.Location == null && e.get_BoundingBox(null) == null)
                // These exact native base objects expose identity/parameters but no public geometry.
                // Never infer their private role from a name or adjacent ID, or claim private fields read.
                shape = new { kind = "opaque_element_public_state", category = (object?)null, typeId = -1,
                    location = (object?)null, box = (object?)null, privateStateInspected = false };
            else return OperatorNativeEffectState.Unavailable(id, "unsupported_native_effect_class:" + e.GetType().Name);
            var type = doc.GetElement(e.GetTypeId());
            return OperatorNativeEffectState.Capture(id, true, new { elementId = id, found = true, uniqueId = e.UniqueId,
                className = e.GetType().Name, name = e.Name, ownerViewId = ElementIdCompat.GetValue(e.OwnerViewId),
                typeUniqueId = type?.UniqueId, parameters = Parameters(e), shape });
        }
        private static object[] Parameters(Element element)
        {
            var ps = element.Parameters.Cast<Parameter>().OrderBy(p => ElementIdCompat.GetValue(p.Id)).ThenBy(p => p.Definition.Name, StringComparer.Ordinal).Take(513).ToArray();
            if (ps.Length > 512) throw new InvalidOperationException("Native parameter observation capacity exceeded.");
            return ps.Select(p => {
                object? value = null;
                if (p.HasValue) switch (p.StorageType)
                {
                    case StorageType.String: value = p.AsString(); break;
                    case StorageType.Integer: value = p.AsInteger(); break;
                    case StorageType.Double: value = p.AsDouble(); break;
                    case StorageType.ElementId: value = ElementIdCompat.GetValue(p.AsElementId()); break;
                    case StorageType.None: break;
                    default: throw new InvalidOperationException("Unknown native parameter storage.");
                }
                if (value is string s && s.Length > 8192) throw new InvalidOperationException("Native parameter value oversized.");
                return (object)new { parameterId = ElementIdCompat.GetValue(p.Id), name = p.Definition.Name,
                    storageType = p.StorageType.ToString(), hasValue = p.HasValue, value };
            }).ToArray();
        }
        private static object Style(GraphicsStyle style)
        {
            var c = style.GraphicsStyleCategory; var mode = style.GraphicsStyleType;
            var color = c.LineColor; var patternId = c.GetLinePatternId(mode);
            var pattern = style.Document.GetElement(patternId) as LinePatternElement;
            return new { kind = "graphics_style", uniqueId = style.UniqueId, mode = mode.ToString(), category = c.Name,
                weight = c.GetLineWeight(mode), color = new[] { (int)color.Red, (int)color.Green, (int)color.Blue },
                patternId = ElementIdCompat.GetValue(patternId),
                pattern = pattern?.GetLinePattern().GetSegments().Select(s => new { type = s.Type.ToString(), length = s.Length }).ToArray() };
        }
        private static T[] Bound<T>(IEnumerable<T> source,int maximum) => OperatorNativeEffectState.Bounded(source,maximum);
        private static object[][] Loops(IEnumerable<IEnumerable<Curve>> loops)
        {
            var arrays=Bound(loops,64).Select(loop=>Bound(loop,2048)).ToArray();
            if(arrays.Length==0 || arrays.Any(loop=>loop.Length==0) || arrays.Sum(loop=>loop.Length)>2048)
                throw new InvalidOperationException("Native profile is empty or exceeds its observation bound.");
            return arrays.Select(loop=>loop.Select(NativeDraftingCurveGeometry.Read).ToArray()).ToArray();
        }
        private static object Plane(Autodesk.Revit.DB.Plane plane) => new {origin=Point(plane.Origin),normal=Point(plane.Normal),x=Point(plane.XVec),y=Point(plane.YVec)};
        private static object ColorState(Color color) => color.IsValid ? (object)new {valid=true,r=(int)color.Red,g=(int)color.Green,b=(int)color.Blue} : new {valid=false};
        private static object RegionType(FilledRegionType type) => new {kind="filled_region_type",uniqueId=type.UniqueId,
            masking=type.IsMasking,lineWeight=type.LineWeight,foregroundColor=ColorState(type.ForegroundPatternColor),
            backgroundColor=ColorState(type.BackgroundPatternColor),foreground=Fill(type.Document,type.ForegroundPatternId),background=Fill(type.Document,type.BackgroundPatternId)};
        private static object Fill(Document doc,ElementId id)
        {
            if(id==ElementId.InvalidElementId)return new {elementId=-1,pattern=(object?)null};
            return Fill(doc.GetElement(id) as FillPatternElement ?? throw new InvalidOperationException("Native fill pattern identity is unresolved."));
        }
        private static object Fill(FillPatternElement element)
        {
            using var p=element.GetFillPattern();
            var grids=Bound(p.GetFillGrids(),64).Select(g=>new {angle=g.Angle,origin=new {u=g.Origin.U,v=g.Origin.V},
                offset=g.Offset,shift=g.Shift,segments=Bound(g.GetSegments(),512)}).ToArray();
            return new {kind="fill_pattern",elementId=ElementIdCompat.GetValue(element.Id),uniqueId=element.UniqueId,
                solid=p.IsSolidFill,target=p.Target.ToString(),orientation=p.HostOrientation.ToString(),grids};
        }
        private static object? DimensionCurve(Curve? curve) => curve==null ? null : curve is Line line && !line.IsBound
            ? new {kind="Line",isBound=false,origin=Point(line.Origin),direction=Point(line.Direction)}
            : NativeDraftingCurveGeometry.Read(curve);
        private static object? NullablePoint(XYZ? point) => point==null ? null : Point(point);
        private static object DimensionState(Dimension dimension)
        {
            var count=dimension.NumberOfSegments;
            if(count<0 || count>128)throw new InvalidOperationException("Native dimension segment count exceeds its bound.");
            var references=Bound(dimension.References.Cast<Reference>(),256).Select(r=>new {
                elementId=ElementIdCompat.GetValue(r.ElementId),linkedElementId=ElementIdCompat.GetValue(r.LinkedElementId),
                referenceType=r.ElementReferenceType.ToString(),stable=r.ConvertToStableRepresentation(dimension.Document)}).ToArray();
            var adjustable=dimension.IsTextPositionAdjustable();
            var segments=count==0 ? Array.Empty<object>() : Bound(dimension.Segments.Cast<DimensionSegment>(),128).Select(s=>{
                var textAdjustable=s.IsTextPositionAdjustable();
                return (object)new {value=s.Value,valueString=s.ValueString,origin=NullablePoint(s.Origin),locked=s.IsLocked,
                    above=s.Above,below=s.Below,prefix=s.Prefix,suffix=s.Suffix,valueOverride=s.ValueOverride,
                    textAdjustable,textPosition=textAdjustable?NullablePoint(s.TextPosition):null,
                    leaderEnd=textAdjustable&&dimension.HasLeader?NullablePoint(s.LeaderEndPosition):null};
            }).ToArray();
            if(segments.Length!=count)throw new InvalidOperationException("Native dimension segment observation is incomplete.");
            var type=dimension.DimensionType ?? throw new InvalidOperationException("Native dimension type is unresolved.");
            return new {kind="dimension",valid=dimension.IsValid,referencesAvailable=dimension.AreReferencesAvailable,
                shape=dimension.DimensionShape.ToString(),curve=DimensionCurve(dimension.Curve),references,
                segmentCount=count,segments,locked=dimension.IsLocked,segmentsEqual=count>1?(bool?)dimension.AreSegmentsEqual:null,
                value=count==0?dimension.Value:null,valueString=count==0?dimension.ValueString:null,
                origin=count==0?NullablePoint(dimension.Origin):null,
                above=count==0?dimension.Above:null,below=count==0?dimension.Below:null,prefix=count==0?dimension.Prefix:null,
                suffix=count==0?dimension.Suffix:null,valueOverride=count==0?dimension.ValueOverride:null,
                textAdjustable=adjustable,textPosition=adjustable?NullablePoint(dimension.TextPosition):null,
                hasLeader=dimension.HasLeader,leaderEnd=adjustable&&dimension.HasLeader?NullablePoint(dimension.LeaderEndPosition):null,
                typeParameters=Parameters(type)};
        }
        private static object Point(XYZ p) => new { x = p.X, y = p.Y, z = p.Z };
        private static object? Box(Element e) { var b = e.get_BoundingBox(null); return b == null ? null : new { min = Point(b.Min), max = Point(b.Max) }; }
    }
}
