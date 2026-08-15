using System;
using System.Text.Json;
using System.Threading.Tasks;
using Autodesk.Revit.UI;
using RevitBridge.Operator;

namespace RevitBridge.Handlers
{
    /// <summary>
    /// Queues Revit's native Close command so the active document transition runs
    /// after the current ExternalEvent/API callback has returned. Revit forbids
    /// switching or closing the active document from inside that callback.
    /// </summary>
    public class CloseActiveModelHandler : IRequestHandler
    {
        public class Params
        {
            public bool discardUnsavedChanges { get; set; } = false;
        }

        public Task<object> Handle(UIApplication app, string jsonData)
        {
            var p = JsonSerializer.Deserialize<Params>(jsonData) ?? new Params();
            var document = app.ActiveUIDocument?.Document;
            if (document == null)
            {
                return Task.FromResult<object>(new
                {
                    status = "No Active Document",
                    commandPosted = false,
                    requestedEffectSatisfied = true
                });
            }

            var wasModified = document.IsModified;
            if (wasModified && !p.discardUnsavedChanges)
            {
                return Task.FromResult<object>(new
                {
                    status = "Discard Authorization Required",
                    commandPosted = false,
                    requestedEffectSatisfied = false,
                    requiresExplicitDiscard = true,
                    title = document.Title,
                    path = document.PathName
                });
            }

            var commandId = RevitCommandId.LookupPostableCommandId(PostableCommand.Close);
            if (!app.CanPostCommand(commandId))
                throw new InvalidOperationException("Revit cannot post the native Close command in the current state.");

            object? dialogGuard = null;
            if (wasModified)
            {
                var service = RevitBridge.App.Instance?.DialogComputerUse
                    ?? throw new InvalidOperationException(
                        "discardUnsavedChanges requires the Revit dialog guardian, but it is unavailable in this session.");
                dialogGuard = service.ArmGuard(new OperatorDialogComputerUse.GuardParams
                {
                    button = "no",
                    interactionMode = "message_then_mouse",
                    cursorRestoreMode = "keep",
                    messageContains = "save changes",
                    maxTriggers = 1,
                    ttlMs = 120000,
                    includeScreenshotAfter = false
                });
            }

            app.PostCommand(commandId);
            return Task.FromResult<object>(new
            {
                status = "Close Posted",
                commandPosted = true,
                requestedEffectSatisfied = false,
                verificationRequired = true,
                discardedUnsavedChanges = wasModified && p.discardUnsavedChanges,
                title = document.Title,
                path = document.PathName,
                dialogGuard
            });
        }
    }
}
