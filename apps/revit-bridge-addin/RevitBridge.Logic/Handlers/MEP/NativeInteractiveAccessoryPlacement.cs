using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Linq;
using System.Runtime.InteropServices;
using System.Threading;
using Autodesk.Revit.DB;
using Autodesk.Revit.DB.Events;
using Autodesk.Revit.UI;
using RevitBridge.Common;

namespace RevitBridge.Logic.Handlers.MEP
{
    /// <summary>
    /// Native placement adapter with the host's owned interactive-input lifecycle.
    /// Revit owns the
    /// placement transactions, sizing, splitting and connections. Do not put an
    /// outer Transaction around this call or replace it with NewFamilyInstance.
    /// </summary>
    internal static class NativeInteractiveAccessoryPlacement
    {
        public static object Execute(UIApplication app, FamilySymbol symbol, int maximumPlacements,
            CancellationToken cancellationToken, Action enterNativeScope, NativeInteractiveAccessoryObservation.Scope scope)
        {
            if (maximumPlacements < 1 || maximumPlacements > 50)
                throw new ArgumentOutOfRangeException(nameof(maximumPlacements));
            cancellationToken.ThrowIfCancellationRequested();
            var ui = app.ActiveUIDocument ?? throw new InvalidOperationException("No active project.");
            var doc = ui.Document;
            if (doc.IsFamilyDocument || doc.IsReadOnly || doc.IsModifiable || !symbol.IsValidObject
                || !doc.Equals(symbol.Document))
                throw new InvalidOperationException("Native placement requires a current project symbol outside a transaction.");
            var category = symbol.Category == null ? 0 : ElementIdCompat.GetValue(symbol.Category.Id);
            if (category != (long)BuiltInCategory.OST_DuctAccessory && category != (long)BuiltInCategory.OST_PipeAccessory)
                throw new ArgumentException("Only duct and pipe accessories are supported by this adapter.");
            // Establish lossless transport viability before entering the native
            // placement tool. This is not a placement or preservation verdict.
            var retainedBefore = NativePreservationSnapshotCodec.PackPlacement(scope.Before);
            var viewId = ui.ActiveView.Id;
            var sourceId = ElementIdCompat.GetValue(symbol.Id);
            var sourceUid = symbol.UniqueId;
            var capture = new OperatorNativeInteractivePlacementCapture(doc);
            var placedIds = new HashSet<long>();
            var mainWindow = app.MainWindowHandle;
            var processId = (uint)Process.GetCurrentProcess().Id;
            var active = 0;
            var escapeAttempted = 0;
            var escapePosted = 0;
            var placementCountCaptureFailed = false;
            void CancelOwnedPrompt()
            {
                // No global keyboard input, foreground activation or guessed PID.
                // Cancellation targets only this invocation's own Revit window.
                if (Volatile.Read(ref active) != 1 || !IsWindow(mainWindow)) return;
                GetWindowThreadProcessId(mainWindow, out var windowProcess);
                if (windowProcess != processId || Interlocked.Exchange(ref escapeAttempted, 1) != 0) return;
                var posted = true;
                for (var i = 0; i < 2; i++)
                {
                    posted &= PostMessage(mainWindow, 0x0100, new IntPtr(0x1B), IntPtr.Zero);
                    posted &= PostMessage(mainWindow, 0x0101, new IntPtr(0x1B), IntPtr.Zero);
                }
                Volatile.Write(ref escapePosted, posted ? 1 : 0);
            }
            void Changed(object sender, DocumentChangedEventArgs e)
            {
                capture.Observe(() => e.GetDocument(), () => e.Operation.ToString(),
                    () => e.GetAddedElementIds().Select(ElementIdCompat.GetValue),
                    () => e.GetModifiedElementIds().Select(ElementIdCompat.GetValue),
                    () => e.GetDeletedElementIds().Select(ElementIdCompat.GetValue));
                try
                {
                    if (!doc.Equals(e.GetDocument()) || e.Operation.ToString() != "TransactionCommitted") return;
                    foreach (var id in e.GetAddedElementIds())
                        if (doc.GetElement(id) is FamilyInstance instance && instance.GetTypeId() == symbol.Id)
                            placedIds.Add(ElementIdCompat.GetValue(id));
                    if (placedIds.Count >= maximumPlacements) CancelOwnedPrompt();
                }
                catch { placementCountCaptureFailed = true; CancelOwnedPrompt(); }
            }

            bool returned = false, cancelled = false;
            string? error = null;
            object? planFocus = null;
            app.Application.DocumentChanged += Changed;
            try
            {
                enterNativeScope();
                try
                {
                    cancellationToken.ThrowIfCancellationRequested();
                    planFocus = FocusSinglePlanHost(ui, scope, maximumPlacements);
                    cancellationToken.ThrowIfCancellationRequested();
                    Volatile.Write(ref active, 1);
                    using (var cancellation = cancellationToken.Register(CancelOwnedPrompt))
                    {
                        try { ui.PromptForFamilyInstancePlacement(symbol); returned = true; }
                        finally { Volatile.Write(ref active, 0); }
                    }
                }
                catch (Autodesk.Revit.Exceptions.OperationCanceledException)
                {
                    // Escape ends the interactive tool; it does not undo already
                    // committed placements. The observed transaction history wins.
                    returned = true;
                    cancelled = true;
                }
                catch (Exception ex) { error = ex.GetType().Name + ": " + ex.Message; }
            }
            finally
            {
                Volatile.Write(ref active, 0);
                app.Application.DocumentChanged -= Changed;
            }

            bool sameContext;
            try
            {
                sameContext = doc.IsValidObject && doc.Equals(app.ActiveUIDocument?.Document)
                    && app.ActiveUIDocument.ActiveView.Id == viewId
                    && doc.GetElement(ElementIdCompat.Create(sourceId))?.UniqueId == sourceUid;
            }
            catch { sameContext = false; }
            var receipt = capture.Finish(returned, sameContext);
            object? placed = null;
            object? preservationAfter = null;
            object? retainedAfter = null;
            var placementCount = 0;
            string? readbackError = null;
            // Failure while describing committed work must retain its receipt.
            // It is not evidence that the placement never occurred.
            if (sameContext)
            {
                try
                {
                    var instances = capture.ObservedAddedIds
                        .Select(id => doc.GetElement(ElementIdCompat.Create(id)))
                        .OfType<FamilyInstance>().Where(instance => instance.GetTypeId() == symbol.Id)
                        .Select(instance => new { elementId = ElementIdCompat.GetValue(instance.Id), uniqueId = instance.UniqueId })
                        .ToArray();
                    placed = instances;
                    placementCount = instances.Length;
                    preservationAfter = NativeInteractiveAccessoryObservation.After(app, scope, receipt);
                    retainedAfter = NativePreservationSnapshotCodec.PackPlacement(preservationAfter);
                }
                catch (Exception ex) { readbackError = ex.GetType().Name + ": " + ex.Message; }
            }
            return new
            {
                status = receipt.CommittedValue == true ? "Native Placement Effects Recorded" : "Native Placement Requires Reconciliation",
                success = receipt.CommittedValue == true && readbackError == null && !placementCountCaptureFailed
                    && placementCount > 0 && placementCount <= maximumPlacements,
                applied = receipt.CommittedValue,
                transaction = receipt,
                changeTracking = capture.Diagnostics(),
                nativeInvocationReturned = returned,
                interactionCancelled = cancelled,
                cancellationRequested = cancellationToken.IsCancellationRequested,
                maximumPlacements,
                planFocus,
                escapeAttempted = escapeAttempted == 1,
                escapePosted = escapePosted == 1,
                placementCountCaptureFailed,
                error,
                sourceTypeId = sourceId,
                sourceTypeUniqueId = sourceUid,
                placedInstances = placed,
                calculatedFlowReview = NativeConnectorFlowObservation.Changes(scope.Before, preservationAfter),
                preservationBefore = retainedBefore,
                preservationAfter = retainedAfter,
                placementCount,
                readbackError,
                postconditionVerified = false,
                verificationRequired = true
            };
        }

        private static object FocusSinglePlanHost(UIDocument ui, NativeInteractiveAccessoryObservation.Scope scope, int maximumPlacements)
        {
            // Existing navigation operation, not a transaction, hide/isolate or
            // model edit. Batch and non-plan framing remain the caller's choice.
            if (scope.HostIdentities.Length != 1 || maximumPlacements != 1 || ui.ActiveView is not ViewPlan)
                return new { applied=false, reason="not_single_host_single_placement_plan" };
            var identity=scope.HostIdentities[0];
            var host=ui.Document.GetElement(ElementIdCompat.Create(identity.elementId)) as MEPCurve;
            if (host == null || host.UniqueId != identity.uniqueId || (host.Location as LocationCurve)?.Curve is not Line line)
                throw new InvalidOperationException("The exact straight host changed before plan focus.");
            double size;
            if (host is Autodesk.Revit.DB.Plumbing.Pipe pipe) size=pipe.Diameter;
            else if (host is Autodesk.Revit.DB.Mechanical.Duct duct)
            {
                var port=duct.ConnectorManager.Connectors.Cast<Connector>().First(c=>c.ConnectorType==ConnectorType.End);
                size=port.Shape==ConnectorProfileType.Round ? 2*port.Radius : Math.Max(port.Width,port.Height);
            }
            else throw new InvalidOperationException("Plan focus requires the scoped duct or pipe.");
            double[] V(XYZ v)=>new[]{v.X,v.Y,v.Z};
            var focus=NativeAccessoryPlanFocus.Create(1,1,true,V(line.GetEndPoint(0)),V(line.GetEndPoint(1)),
                V(ui.ActiveView.RightDirection),V(ui.ActiveView.UpDirection),size);
            if (focus==null) return new { applied=false,reason="host_is_end_on_in_plan" };
            var window=ui.GetOpenUIViews().SingleOrDefault(v=>v.ViewId==ui.ActiveView.Id)
                ?? throw new InvalidOperationException("Current plan has no open drawing window for host focus.");
            var visible=new FilteredElementCollector(ui.Document,ui.ActiveView.Id).WhereElementIsNotElementType().ToElementIds();
            if (!visible.Contains(host.Id)) throw new InvalidOperationException("Scoped host is not visible in the current plan.");
            window.ZoomAndCenterRectangle(new XYZ(focus.LowerLeft[0],focus.LowerLeft[1],focus.LowerLeft[2]),
                new XYZ(focus.UpperRight[0],focus.UpperRight[1],focus.UpperRight[2]));
            return new { applied=true,hostElementId=identity.elementId,hostUniqueId=identity.uniqueId,
                viewId=ElementIdCompat.GetValue(ui.ActiveView.Id),viewUniqueId=ui.ActiveView.UniqueId,
                center=focus.Center,lowerLeft=focus.LowerLeft,upperRight=focus.UpperRight,units="internal_feet",
                scope="navigation_only_midpoint_context; not_cursor_snap_constraint_or_placement_verification" };
        }

        [DllImport("user32.dll")]
        private static extern bool IsWindow(IntPtr window);
        [DllImport("user32.dll")]
        private static extern uint GetWindowThreadProcessId(IntPtr window, out uint processId);
        [DllImport("user32.dll", SetLastError = true)]
        private static extern bool PostMessage(IntPtr window, uint message, IntPtr wParam, IntPtr lParam);
    }
}
