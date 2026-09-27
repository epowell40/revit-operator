using System;
using System.Collections.Generic;
using System.Linq;

namespace RevitBridge.Common
{
    public sealed class OperatorViewActivationOutcome
    {
        public long RequestedViewId { get; }
        public long? ActiveViewId { get; }
        public bool ActivationPending => ActiveViewId != RequestedViewId;
        public bool DeferredRequestAccepted { get; }
        public OperatorViewActivationOutcome(long requested, long? active, bool deferred)
        { RequestedViewId = requested; ActiveViewId = active; DeferredRequestAccepted = deferred; }
    }

    public static class OperatorViewActivation
    {
        public static OperatorViewActivationOutcome Attempt(long requestedViewId, Func<long?> readActiveView,
            Action activate, Action requestDeferred, Func<Exception, bool> mayDefer)
        {
            if (requestedViewId <= 0) throw new ArgumentException("A valid requested view is required.");
            var deferred = false;
            if (readActiveView() != requestedViewId)
            {
                try { activate(); }
                catch (Exception error) when (mayDefer(error)) { requestDeferred(); deferred = true; }
            }
            // Neither a setter returning nor an accepted asynchronous request is
            // evidence that the requested view is currently displayed.
            return new OperatorViewActivationOutcome(requestedViewId, readActiveView(), deferred);
        }
    }

    public sealed class OperatorViewportObservation
    {
        public long ViewId { get; }
        public double[][] ZoomCornersXyz { get; }
        public OperatorViewportObservation(long viewId, double[][] corners)
        { ViewId = viewId; ZoomCornersXyz = corners.Select(point => point.ToArray()).ToArray(); }
    }

    public static class OperatorViewImageContract
    {
        public const string FullView = "full_view";
        public const string VisibleRegion = "visible_region";
        public static string ResolveMode(string? mode)
        {
            if (mode == null) return FullView;
            if (mode != FullView && mode != VisibleRegion)
                throw new ArgumentException("exportMode must be full_view or visible_region.");
            return mode;
        }

        public static object ExportModeSchema() => new Dictionary<string, object>
        {
            ["type"] = "string", ["enum"] = new[] { FullView, VisibleRegion },
            ["description"] = "Default full_view exports the whole requested view. visible_region exports only the currently displayed viewport and requires that view to be active."
        };

        public static OperatorViewportObservation RequireViewport(long requestedViewId, long? activeViewId,
            long? uiViewId, double[][]? corners)
        {
            if (requestedViewId <= 0 || activeViewId != requestedViewId)
                throw new InvalidOperationException("visible_region requires the requested view to be the observed active view; complete activation first.");
            if (uiViewId != requestedViewId)
                throw new InvalidOperationException("visible_region requires an open UIView for the observed active view.");
            if (corners == null || corners.Length != 2 || corners.Any(point => point == null || point.Length != 3
                || point.Any(value => double.IsNaN(value) || double.IsInfinity(value)))
                || corners[0].SequenceEqual(corners[1]))
                throw new InvalidOperationException("Visible viewport zoom corners are unavailable or invalid.");
            return new OperatorViewportObservation(requestedViewId, corners);
        }

        public static void RequireUnchanged(OperatorViewportObservation before, OperatorViewportObservation after)
        {
            if (before.ViewId != after.ViewId || before.ZoomCornersXyz.Where((point, i) =>
                point.Where((value, axis) => Math.Abs(value - after.ZoomCornersXyz[i][axis]) > 1e-9).Any()).Any())
                throw new InvalidOperationException("The active viewport changed during visible_region export; the image cannot be attributed to the requested framing.");
        }
    }
}
