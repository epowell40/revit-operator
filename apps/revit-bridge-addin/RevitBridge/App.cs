using System;
using System.IO;
using System.Reflection;
using Autodesk.Revit.UI;
using RevitBridge.Operator;
using RevitBridge.Server;
using RevitBridge.Services;

namespace RevitBridge
{
    public class App : IExternalApplication
    {
        public static App Instance { get; private set; }
        private static string _assemblyPath = Assembly.GetExecutingAssembly().Location;
        
        private RevitHttpServer _server;
        private RevitEventService _eventService;
        internal OperatorDialogComputerUse? DialogComputerUse { get; private set; }

        public Result OnStartup(UIControlledApplication application)
        {
            Instance = this;
            WriteStartupLog("OnStartup begin.");
            
            // Init Service & Server
            _eventService = new RevitEventService();
            _server = new RevitHttpServer(_eventService);
            _server.Start();
            WriteStartupLog("HTTP server start requested.");

            // Ensure Operator backend is up (separate process)
            OperatorBackendAutoStart.TryStartInBackground();

            try
            {
                DialogComputerUse = new OperatorDialogComputerUse(application);
            }
            catch { }

            // Register DockablePane (don't hard-fail if already registered)
            try
            {
                application.RegisterDockablePane(
                    OperatorPaneIds.PaneId,
                    OperatorPaneIds.PaneTitle,
                    new OperatorDockablePaneProvider(_eventService));
            }
            catch { }

            // Create Ribbon (don't hard-fail if tab already exists)
            string tabName = "RevitOperator";
            try { application.CreateRibbonTab(tabName); } catch { }
            RibbonPanel panel = application.CreateRibbonPanel(tabName, "Control");

            try
            {
                PushButtonData btnData = new PushButtonData(
                    "cmdRevitOperator",
                    "Status",
                    _assemblyPath,
                    "RevitBridge.Command"
                );

                btnData.ToolTip = "Check connection status";
                panel.AddItem(btnData);
            }
            catch { }

            try
            {
                PushButtonData operatorBtnData = new PushButtonData(
                    "cmdRevitOperatorPane",
                    "Operator",
                    _assemblyPath,
                    "RevitBridge.Operator.ShowOperatorPaneCommand"
                );
                operatorBtnData.ToolTip = "Open the Operator dockable pane";
                panel.AddItem(operatorBtnData);
            }
            catch { }

            return Result.Succeeded;
        }

        public Result OnShutdown(UIControlledApplication application)
        {
            try { DialogComputerUse?.Dispose(); } catch { }
            _server?.Stop();
            WriteStartupLog("OnShutdown complete.");
            return Result.Succeeded;
        }

        private static void WriteStartupLog(string message)
        {
            try
            {
                var root = Path.Combine(
                    Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                    "RevitOperator",
                    "Logs");
                Directory.CreateDirectory(root);
                File.AppendAllText(
                    Path.Combine(root, "revit-addin-startup.log"),
                    $"[{DateTime.Now:O}] {message}{Environment.NewLine}");
            }
            catch { }
        }
    }
}
