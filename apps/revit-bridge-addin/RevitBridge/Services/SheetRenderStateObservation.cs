using System;
using System.Linq;
using Autodesk.Revit.DB;
using Autodesk.Revit.UI;
using RevitBridge.Common;

namespace RevitBridge.Services
{
    // Read-only render inputs not reliably represented by DocumentChanged,
    // observed alongside the ordinary native document epoch/sequence. No
    // render, transaction, visibility modification or completeness claim for
    // arbitrary model content. Unsupported/failed observations stay unavailable.
    internal static class SheetRenderStateObservation
    {
        public static object? Read(UIDocument uidoc, View view)
        {
            if (!(view is ViewSheet sheet) || view.IsTemplate) return null;
            try
            {
                var doc = view.Document;
                var ids = sheet.GetAllPlacedViews()
                    // A class-filtered ownership read avoids building a view's
                    // visibility/geometry collection on every context read.
                    .Concat(new FilteredElementCollector(doc).OfClass(typeof(ScheduleSheetInstance))
                        .Cast<ScheduleSheetInstance>().Where(instance => instance.OwnerViewId == view.Id)
                        .Select(instance => instance.ScheduleId))
                    .Concat(new[] { view.Id }).Distinct()
                    .OrderBy(ElementIdCompat.GetValue).ToArray();
                if (ids.Length > 128) throw new InvalidOperationException("render_view_limit");
                var modes = Enum.GetValues(typeof(TemporaryViewMode)).Cast<TemporaryViewMode>()
                    .OrderBy(mode => mode.ToString(), StringComparer.Ordinal).ToArray();
                if (modes.Length < 1 || modes.Length > 32) throw new InvalidOperationException("render_mode_limit");
                var entries = ids.Select(id =>
                {
                    var child = doc.GetElement(id) as View;
                    if (child == null || !child.IsValidObject || child.IsTemplate) throw new InvalidOperationException("render_view_unavailable");
                    return new OperatorSheetRenderView
                    {
                        Id = ElementIdCompat.GetValue(child.Id), UniqueId = child.UniqueId,
                        Customized = child.TemporaryViewModes?.IsCustomized() ?? false,
                        TemporaryModes = modes.ToDictionary(mode => mode.ToString(), mode => child.IsInTemporaryViewMode(mode), StringComparer.Ordinal)
                    };
                }).ToArray();
                double[][]? corners = null;
                if (uidoc.ActiveView?.Id == view.Id)
                {
                    var uiView = uidoc.GetOpenUIViews().FirstOrDefault(candidate => candidate.ViewId == view.Id);
                    corners = uiView?.GetZoomCorners().Select(point => new[] { point.X, point.Y, point.Z }).ToArray();
                }
                return OperatorSheetRenderObservation.Create(ElementIdCompat.GetValue(view.Id), view.UniqueId,
                    modes.Select(mode => mode.ToString()), entries, corners);
            }
            catch
            {
                return OperatorSheetRenderObservation.Unavailable();
            }
        }
    }
}
