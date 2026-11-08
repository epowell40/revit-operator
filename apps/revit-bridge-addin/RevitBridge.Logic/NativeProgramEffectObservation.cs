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
        private static object Point(XYZ p) => new { x = p.X, y = p.Y, z = p.Z };
        private static object? Box(Element e) { var b = e.get_BoundingBox(null); return b == null ? null : new { min = Point(b.Min), max = Point(b.Max) }; }
    }
}
