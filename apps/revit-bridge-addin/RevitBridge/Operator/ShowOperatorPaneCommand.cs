using Autodesk.Revit.Attributes;
using Autodesk.Revit.DB;
using Autodesk.Revit.UI;

namespace RevitBridge.Operator
{
    [Transaction(TransactionMode.Manual)]
    public class ShowOperatorPaneCommand : IExternalCommand
    {
        public Result Execute(ExternalCommandData commandData, ref string message, ElementSet elements)
        {
            if (OperatorDesktopLauncher.UseLegacyPane())
            {
                var pane = commandData.Application.GetDockablePane(OperatorPaneIds.PaneId);
                pane?.Show();
                return Result.Succeeded;
            }

            if (!OperatorDesktopLauncher.TryLaunch(out var detail))
            {
                TaskDialog.Show(
                    "Revit Operator",
                    "Operator Desktop could not be launched.\n\n" + detail
                    + "\n\nRun Operator Desktop from the workstation package, or set OPERATOR_UI_MODE=pane and restart Revit to use the legacy pane.");
            }

            return Result.Succeeded;
        }
    }
}

