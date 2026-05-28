using System;
using Autodesk.Revit.UI;

namespace RevitBridge.Operator
{
    public static class OperatorPaneIds
    {
        public static readonly Guid PaneGuid = new Guid("8A5D58F6-7D2C-4E55-8B6C-2BB0C7B4E5B9");
        public static readonly DockablePaneId PaneId = new DockablePaneId(PaneGuid);
        public const string PaneTitle = "Operator";
    }
}

