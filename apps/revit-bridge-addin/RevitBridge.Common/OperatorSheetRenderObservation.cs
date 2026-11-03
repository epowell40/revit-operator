using System;
using System.Collections.Generic;
using System.Linq;

namespace RevitBridge.Common
{
    public sealed class OperatorSheetRenderView
    {
        public long Id { get; set; }
        public string UniqueId { get; set; } = "";
        public bool Customized { get; set; }
        public IDictionary<string, bool> TemporaryModes { get; set; } = new Dictionary<string, bool>();
    }

    public static class OperatorSheetRenderObservation
    {
        public static object Unavailable() => new { schema = "operator.sheet-render-state.v1", state = "unavailable" };

        // Pure bounded serializer for actual native observations. Active modes
        // remain active in the output; this never certifies stable rendering.
        public static object Create(long sheetId, string sheetUniqueId, IEnumerable<string> suppliedModes,
            IEnumerable<OperatorSheetRenderView> suppliedViews, double[][]? corners)
        {
            var modes = suppliedModes.Take(33).ToArray();
            var views = suppliedViews.Take(129).ToArray();
            if (sheetId <= 0 || string.IsNullOrWhiteSpace(sheetUniqueId) || sheetUniqueId.Length > 200
                || modes.Length < 1 || modes.Length > 32 || modes.Distinct(StringComparer.Ordinal).Count() != modes.Length
                || modes.Any(name => string.IsNullOrWhiteSpace(name) || name.Length > 80)
                || views.Length < 1 || views.Length > 128 || views.Select(view => view.Id).Distinct().Count() != views.Length
                || views.Select(view => view.UniqueId).Distinct(StringComparer.Ordinal).Count() != views.Length
                || !views.Any(view => view.Id == sheetId && view.UniqueId == sheetUniqueId)
                || views.Any(view => view.Id <= 0 || string.IsNullOrWhiteSpace(view.UniqueId) || view.UniqueId.Length > 200
                    || view.TemporaryModes == null || view.TemporaryModes.Count != modes.Length || modes.Any(mode => !view.TemporaryModes.ContainsKey(mode))))
                throw new ArgumentException("Incomplete or unbounded sheet render observation.");
            if (corners != null)
                corners = OperatorViewImageContract.RequireViewport(sheetId, sheetId, sheetId, corners).ZoomCornersXyz;
            return new
            {
                schema = "operator.sheet-render-state.v1", state = "available", scope = "sheet_and_placed_views",
                viewId = sheetId, viewUniqueId = sheetUniqueId,
                modeNames = modes.OrderBy(name => name, StringComparer.Ordinal).ToArray(),
                views = views.OrderBy(view => view.Id).Select(view => new
                {
                    viewId = view.Id, viewUniqueId = view.UniqueId, customizedTemporaryMode = view.Customized,
                    temporaryModes = modes.OrderBy(name => name, StringComparer.Ordinal).Select(name => new { name, active = view.TemporaryModes[name] }).ToArray()
                }).ToArray(),
                activeViewportCornersXyz = corners,
                limits = "Render-state observation only. Requires same native document epoch/sequence; no model, file, engineering or live-screen proof. Dynamic printed labels belong to the captured artifact."
            };
        }
    }
}
