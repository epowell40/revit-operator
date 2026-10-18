using System;
using System.Linq;
using System.Text.Json;
using Autodesk.Revit.DB;
using RevitBridge.Common;

namespace RevitBridge.Logic
{
    public static class XlsxNativeTableSnapshot
    {
        public static string Hash(Document document, XlsxNativeTablePart part) => XlsxTablePlanCodec.Hash(JsonSerializer.Serialize(Read(document, part)));
        public static object Read(Document document, XlsxNativeTablePart part)
        {
            var view = document.GetElement(ElementIdCompat.Create(part.ViewId)) as View ?? throw new InvalidOperationException("Imported Excel view is missing.");
            if (view.UniqueId != part.ViewUniqueId || view.IsTemplate || view.ViewType != ViewType.DraftingView || part.Notes.Count + part.Borders.Count > 3500)
                throw new InvalidOperationException("Imported Excel view/part identity or bound changed.");
            object Point(XYZ p) => new { x = p.X, y = p.Y, z = p.Z };
            var notes = part.Notes.Select(record =>
            {
                var note = document.GetElement(ElementIdCompat.Create(record.Id)) as TextNote ?? throw new InvalidOperationException("Imported Excel cell text is missing.");
                if (note.UniqueId != record.UniqueId || note.OwnerViewId != view.Id) throw new InvalidOperationException("Imported Excel cell identity/owner changed.");
                var type = note.TextNoteType;
                return new { text = DrawingSpecNativeTextFormatting.Read(note, record.Ranges.Select(r => (r[0], r[1])).ToArray()), type.UniqueId, baseDirection = Point(note.BaseDirection), upDirection = Point(note.UpDirection),
                    baseBold = type.get_Parameter(BuiltInParameter.TEXT_STYLE_BOLD).AsInteger(), baseItalic = type.get_Parameter(BuiltInParameter.TEXT_STYLE_ITALIC).AsInteger(),
                    baseUnderline = type.get_Parameter(BuiltInParameter.TEXT_STYLE_UNDERLINE).AsInteger(), widthScale = type.get_Parameter(BuiltInParameter.TEXT_WIDTH_SCALE).AsDouble(),
                    background = type.get_Parameter(BuiltInParameter.TEXT_BACKGROUND).AsInteger() };
            }).ToArray();
            var borders = part.Borders.Select(record =>
            {
                var curve = document.GetElement(ElementIdCompat.Create(record.Id)) as DetailCurve ?? throw new InvalidOperationException("Imported Excel border is missing.");
                if (curve.UniqueId != record.UniqueId || curve.OwnerViewId != view.Id || !(curve.GeometryCurve is Line)) throw new InvalidOperationException("Imported Excel border identity/owner/geometry changed.");
                using var graphics = view.GetElementOverrides(curve.Id);var color = graphics.ProjectionLineColor;
                return new { record.Id, curve.UniqueId, ownerViewId = part.ViewId, start = Point(curve.GeometryCurve.GetEndPoint(0)), end = Point(curve.GeometryCurve.GetEndPoint(1)),
                    weight = graphics.ProjectionLineWeight, color = color.IsValid ? new[] { (int)color.Red, color.Green, color.Blue } : null,
                    patternId = ElementIdCompat.GetValue(graphics.ProjectionLinePatternId), lineStyleId = ElementIdCompat.GetValue(curve.LineStyle.Id) };
            }).ToArray();
            return new { scope = "owned_excel_part_native_text_format_geometry_and_border_snapshot_not_visual_or_engineering", part.ViewId, view.UniqueId, view.Name, view.Scale,
                origin = Point(view.Origin), right = Point(view.RightDirection), up = Point(view.UpDirection), notes, borders };
        }
    }
}
