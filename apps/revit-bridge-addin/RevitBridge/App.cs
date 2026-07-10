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

            if (IsDialogComputerUseEnabled())
            {
                try
                {
                    WriteStartupLog("Dialog computer-use registration begin.");
                    DialogComputerUse = new OperatorDialogComputerUse(application);
                    WriteStartupLog("Dialog computer-use registration complete.");
                }
                catch (Exception ex)
                {
                    WriteStartupLog($"Dialog computer-use registration failed: {ex.GetType().FullName}: {ex.Message}");
                }
            }
            else
            {
                WriteStartupLog("Dialog computer-use registration skipped by local setting.");
            }

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
            WriteStartupLog("OnShutdown begin.");
            try
            {
                WriteStartupLog("Dialog computer-use dispose begin.");
                DialogComputerUse?.Dispose();
                WriteStartupLog("Dialog computer-use dispose complete.");
            }
            catch (Exception ex)
            {
                WriteStartupLog($"Dialog computer-use dispose failed: {ex.GetType().FullName}: {ex.Message}");
            }
            try
            {
                WriteStartupLog("HTTP server stop begin.");
                _server?.Stop();
                WriteStartupLog("HTTP server stop complete.");
            }
            catch (Exception ex)
            {
                WriteStartupLog($"HTTP server stop failed: {ex.GetType().FullName}: {ex.Message}");
            }
            WriteStartupLog("OnShutdown complete.");
            return Result.Succeeded;
        }

        private static bool IsDialogComputerUseEnabled()
        {
            if (IsTruthy(ReadSetting("OPERATOR_DISABLE_DIALOG_COMPUTER_USE"))) return false;
            if (IsTruthy(ReadSetting("OPERATOR_DIALOG_COMPUTER_USE_DISABLED"))) return false;

            try
            {
                var flagPath = Path.Combine(
                    Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                    "RevitOperator",
                    "disable-dialog-computer-use.flag");
                if (File.Exists(flagPath)) return false;
            }
            catch { }

            return true;
        }

        private static string ReadSetting(string name)
        {
            try
            {
                var value = Environment.GetEnvironmentVariable(name);
                if (!string.IsNullOrWhiteSpace(value)) return value;
            }
            catch { }
            try
            {
                var value = Environment.GetEnvironmentVariable(name, EnvironmentVariableTarget.User);
                if (!string.IsNullOrWhiteSpace(value)) return value;
            }
            catch { }
            try
            {
                var value = Environment.GetEnvironmentVariable(name, EnvironmentVariableTarget.Machine);
                if (!string.IsNullOrWhiteSpace(value)) return value;
            }
            catch { }
            return "";
        }

        private static bool IsTruthy(string value)
        {
            var normalized = (value ?? "").Trim();
            return string.Equals(normalized, "1", StringComparison.OrdinalIgnoreCase)
                || string.Equals(normalized, "true", StringComparison.OrdinalIgnoreCase)
                || string.Equals(normalized, "yes", StringComparison.OrdinalIgnoreCase)
                || string.Equals(normalized, "on", StringComparison.OrdinalIgnoreCase);
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
