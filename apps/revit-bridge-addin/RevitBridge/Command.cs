using System;
using System.Reflection;
using Autodesk.Revit.Attributes;
using Autodesk.Revit.DB;
using Autodesk.Revit.UI;
using RevitBridge.Operator;

namespace RevitBridge
{
    [Transaction(TransactionMode.Manual)]
    public class Command : IExternalCommand
    {
        public Result Execute(
            ExternalCommandData commandData,
            ref string message,
            ElementSet elements)
        {
            var asm = Assembly.GetExecutingAssembly().Location;
            var backend = OperatorBackendConfig.GetBaseUri().ToString();

            var paneStatus = "unknown";
            try
            {
                var pane = commandData.Application.GetDockablePane(OperatorPaneIds.PaneId);
                paneStatus = pane == null ? "not found" : "registered";
            }
            catch
            {
                paneStatus = "not registered";
            }

            TaskDialog.Show("Revit Operator", $"Revit Bridge is loaded.\n\nAssembly:\n{asm}\n\nOperator pane:\n{paneStatus}\n\nOperator backend:\n{backend}");
            return Result.Succeeded;
        }
    }
}
