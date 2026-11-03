using System;
using System.IO;
using System.Threading;
using System.Threading.Tasks;
using Autodesk.Revit.DB;
using Autodesk.Revit.UI;
using RevitBridge.Common;

namespace RevitBridge.Logic.Handlers.MEP
{
    /// <summary>Owned desktop-input continuation retains the original native invocation.
    /// Uses native interactive insertion; never manually splits or reconnects.</summary>
    public sealed class PlaceMepAccessoryInteractivelyHandler : IInteractiveRequestHandler
    {
        public Task<object> Handle(UIApplication app, string jsonData) => Task.FromResult<object>(new
        {
            status = "Blocked", success = false, applied = false,
            error = "interactive_native_dispatch_required",
            transaction = OperatorNativeTransactionReceipt.NotStarted()
        });

        public Task<object> HandleInteractive(UIApplication app, string jsonData, CancellationToken cancellationToken)
            => Task.FromResult(NativeMutationPreflightBoundary.Execute(enterNativeScope =>
            {
                var request = NativeInteractiveAccessoryRequest.Parse(jsonData);
                cancellationToken.ThrowIfCancellationRequested();
                var ui = app.ActiveUIDocument ?? throw new InvalidOperationException("No active project.");
                var doc = ui.Document;
                if (string.IsNullOrWhiteSpace(doc.PathName) || !Path.IsPathRooted(request.expectedModelPath)
                    || !string.Equals(Path.GetFullPath(doc.PathName), Path.GetFullPath(request.expectedModelPath), StringComparison.OrdinalIgnoreCase)
                    || ElementIdCompat.GetValue(ui.ActiveView.Id) != request.viewId
                    || ui.ActiveView.UniqueId != request.expectedViewUniqueId)
                    throw new ArgumentException("The active native model or view no longer matches the placement request.");
                var symbol = doc.GetElement(ElementIdCompat.Create(request.accessoryTypeId)) as FamilySymbol;
                if (symbol == null || symbol.UniqueId != request.expectedAccessoryTypeUniqueId)
                    throw new ArgumentException("The requested loaded accessory type identity changed.");
                var category = symbol.Category == null ? 0 : ElementIdCompat.GetValue(symbol.Category.Id);
                if (category != (long)BuiltInCategory.OST_DuctAccessory && category != (long)BuiltInCategory.OST_PipeAccessory
                    || doc.IsFamilyDocument || doc.IsReadOnly || doc.IsModifiable)
                    throw new ArgumentException("Native placement requires a loaded duct or pipe accessory in an editable project outside a transaction.");
                var before = NativeInteractiveAccessoryObservation.Before(app, request, symbol);
                return NativeInteractiveAccessoryPlacement.Execute(app, symbol, request.maximumPlacements,
                    cancellationToken, enterNativeScope, before);
            }));
    }
}
