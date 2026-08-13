using System;
using System.IO;
using System.Reflection;
using Autodesk.Revit.DB.Events;
using Autodesk.Revit.UI;
using Autodesk.Revit.UI.Events;
using RevitBridge.Common;
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
        private OperatorRevitCourierWorker? _revitCourierWorker;
        private int _openDocumentCount;
        internal OperatorDialogComputerUse? DialogComputerUse { get; private set; }

        public Result OnStartup(UIControlledApplication application)
        {
            Instance = this;
            WriteStartupLog("OnStartup begin.");

            application.ControlledApplication.DocumentOpened += OnDocumentOpened;
            application.ControlledApplication.DocumentClosing += OnDocumentClosing;
            application.Idling += OnIdling;

            try
            {
                WriteStartupLog("Native mutation transaction checkpoint registration begin.");
                OperatorNativeMutationFailureRegistry.Register(application);
                WriteStartupLog("Native mutation transaction checkpoint registration complete.");
            }
            catch (Exception ex)
            {
                WriteStartupLog($"Native mutation transaction checkpoint registration failed: {ex.GetType().FullName}: {ex.Message}");
            }
            
            // Construct the fixed backend authorizer before exposing any native
            // HTTP listener. Every certified /revit request fails closed through
            // this dependency; no server constructor exists without it.
            var backendAuth = new OperatorAuthSession();
            var backend = new OperatorBackendClient(OperatorBackendConfig.GetBaseUri(), backendAuth);

            // Init Service & Server
            _eventService = new RevitEventService();
            _server = new RevitHttpServer(_eventService, backend);
            _server.Start();
            WriteStartupLog("HTTP server start requested.");

            // Ensure Operator backend is up (separate process)
            OperatorBackendAutoStart.TryStartInBackground();

            // The hosted Codex harness publishes Revit calls through a durable
            // courier. Keep its workstation claimant alive for the lifetime of
            // the add-in; the Sidecar-only UI no longer constructs the legacy pane.
            try
            {
                _revitCourierWorker = new OperatorRevitCourierWorker(
                    backend,
                    new OperatorActionRunner(_eventService),
                    getApprovalMode: GetCourierApprovalMode,
                    ensureWriteGrant: OperatorWriteGrant.ReadStatus,
                    getLogger: () => null);
                _revitCourierWorker.Start();
                WriteStartupLog("Application-lifetime Revit courier worker started; courier dispatch is waiting for an open document.");
            }
            catch (Exception ex)
            {
                WriteStartupLog($"Application-lifetime Revit courier worker failed to start: {ex.GetType().FullName}: {ex.Message}");
            }

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

            // The desktop sidecar is the primary UI. Register the legacy pane only
            // when an explicit rollback mode was selected before Revit startup.
            if (OperatorDesktopLauncher.UseLegacyPane())
            {
                try
                {
                    application.RegisterDockablePane(
                        OperatorPaneIds.PaneId,
                        OperatorPaneIds.PaneTitle,
                        new OperatorDockablePaneProvider(_eventService));
                    WriteStartupLog("Legacy Operator dockable pane registered.");
                }
                catch (Exception ex)
                {
                    WriteStartupLog($"Legacy Operator dockable pane registration failed: {ex.GetType().FullName}: {ex.Message}");
                }
            }
            else
            {
                WriteStartupLog("Legacy Operator dockable pane registration skipped; Operator Desktop is primary.");
            }

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
                    "Operator\nDesktop",
                    _assemblyPath,
                    "RevitBridge.Operator.ShowOperatorPaneCommand"
                );
                operatorBtnData.ToolTip = "Launch or focus Operator Desktop. Set OPERATOR_UI_MODE=pane to use the legacy dockable pane.";
                panel.AddItem(operatorBtnData);
            }
            catch { }

            return Result.Succeeded;
        }

        public Result OnShutdown(UIControlledApplication application)
        {
            WriteStartupLog("OnShutdown begin.");
            application.ControlledApplication.DocumentOpened -= OnDocumentOpened;
            application.ControlledApplication.DocumentClosing -= OnDocumentClosing;
            application.Idling -= OnIdling;
            try
            {
                WriteStartupLog("Operator Desktop launch notification shutdown begin.");
                ShowOperatorPaneCommand.ShutdownDesktopFailureNotifications();
                WriteStartupLog("Operator Desktop launch notification shutdown complete.");
            }
            catch (Exception ex)
            {
                WriteStartupLog($"Operator Desktop launch notification shutdown failed: {ex.GetType().FullName}: {ex.Message}");
            }
            try
            {
                WriteStartupLog("Application-lifetime Revit courier worker dispose begin.");
                _revitCourierWorker?.Dispose();
                _revitCourierWorker = null;
                WriteStartupLog("Application-lifetime Revit courier worker dispose complete.");
            }
            catch (Exception ex)
            {
                WriteStartupLog($"Application-lifetime Revit courier worker dispose failed: {ex.GetType().FullName}: {ex.Message}");
            }
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

        private static void OnDocumentOpened(object sender, DocumentOpenedEventArgs args)
        {
            try { OperatorNativeDocumentSessionAuthority.RegisterOpenedDocument(args.Document); }
            catch (Exception ex) { WriteStartupLog($"Document session registration failed closed: {ex.GetType().FullName}: {ex.Message}"); }
            var instance = Instance;
            if (instance != null)
            {
                System.Threading.Interlocked.Increment(ref instance._openDocumentCount);
            }
        }

        private static void OnIdling(object sender, IdlingEventArgs args)
        {
            var instance = Instance;
            // DocumentOpened can fire while Revit is still loading/rendering the model.
            // The first actual Idling callback is the authoritative signal that the UI
            // thread can execute a newly raised ExternalEvent.
            if (instance != null && System.Threading.Volatile.Read(ref instance._openDocumentCount) > 0)
            {
                instance._revitCourierWorker?.SetHostDocumentAvailable();
                if (sender is UIApplication uiApplication)
                    instance._eventService?.ExecutePendingOnIdling(uiApplication);
            }
        }

        private static void OnDocumentClosing(object sender, DocumentClosingEventArgs args)
        {
            try { OperatorNativeDocumentSessionAuthority.InvalidateClosingDocument(args.Document); }
            catch (Exception ex) { WriteStartupLog($"Document session invalidation failed closed: {ex.GetType().FullName}: {ex.Message}"); }
            var instance = Instance;
            if (instance != null)
            {
                var remaining = System.Threading.Interlocked.Decrement(ref instance._openDocumentCount);
                instance._revitCourierWorker?.SetHostDocumentUnavailable();
                if (remaining <= 0)
                {
                    System.Threading.Interlocked.Exchange(ref instance._openDocumentCount, 0);
                }
            }
        }

        private static OperatorApprovalMode GetCourierApprovalMode()
        {
            var status = OperatorWriteGrant.ReadStatus();
            if (!status.Active) return OperatorApprovalMode.Safe;
            return string.Equals((status.Mode ?? "").Trim(), "yolo", StringComparison.OrdinalIgnoreCase)
                ? OperatorApprovalMode.Yolo
                : OperatorApprovalMode.AllowWritesThisSession;
        }

        private static bool IsDialogComputerUseEnabled()
        {
            if (IsTruthy(ReadSetting("OPERATOR_ENABLE_DIALOG_COMPUTER_USE"))) return true;
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
