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
            var pane = commandData.Application.GetDockablePane(OperatorPaneIds.PaneId);
            pane?.Show();
            return Result.Succeeded;
        }
    }
}

