using Autodesk.Revit.UI;
using RevitBridge.Services;

namespace RevitBridge.Operator
{
    public class OperatorDockablePaneProvider : IDockablePaneProvider
    {
        private readonly RevitEventService _eventService;

        public OperatorDockablePaneProvider(RevitEventService eventService)
        {
            _eventService = eventService;
        }

        public void SetupDockablePane(DockablePaneProviderData data)
        {
            data.FrameworkElement = new OperatorPaneControl(_eventService);
            data.InitialState = new DockablePaneState
            {
                DockPosition = DockPosition.Right
            };
        }
    }
}
