using System;
using System.Diagnostics;
using System.IO;
using System.Threading;
using System.Threading.Tasks;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Media;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.Wpf;
using RevitBridge.Common;

namespace RevitBridge.Operator
{
    // Hosts the existing Sidecar application. There is no Revit API access,
    // second conversation engine, host-object binding, or tool-message bridge.
    internal sealed class OperatorEmbeddedPaneControl : Page
    {
        private static OperatorEmbeddedPaneControl? Current;
        private readonly Grid _root = new Grid();
        private readonly CancellationTokenSource _lifetime = new CancellationTokenSource();
        private WebView2? _browser;
        private bool _opening;

        public OperatorEmbeddedPaneControl()
        {
            Current = this;
            Background = Brushes.White;
            MinWidth = 320;
            Content = _root;
            Loaded += (_, __) => { if (IsVisible) _ = OpenAsync(); };
            IsVisibleChanged += (_, __) => { if (IsVisible) _ = OpenAsync(); };
            ShowMessage("Open Operator beside your model.", false);
        }

        private async Task OpenAsync()
        {
            if (_opening || _browser != null || _lifetime.IsCancellationRequested) return;
            _opening = true;
            ShowMessage("Opening Operator…", false);
            try
            {
                var url = await OperatorDesktopLauncher.LaunchEmbeddedAsync(_lifetime.Token);
                if (_lifetime.IsCancellationRequested) return;
                var browser = new WebView2 {
                    CreationProperties = new CoreWebView2CreationProperties {
                        UserDataFolder = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "RevitOperator", "EmbeddedWebView2")
                    }
                };
                _browser = browser;
                _root.Children.Clear();
                _root.Children.Add(browser);
                var initialization = browser.EnsureCoreWebView2Async();
                if (await Task.WhenAny(initialization, Task.Delay(15000, _lifetime.Token)) != initialization)
                {
                    _ = initialization.ContinueWith(t => { _ = t.Exception; }, TaskContinuationOptions.OnlyOnFaulted);
                    throw new TimeoutException("The conversation window took too long to open.");
                }
                await initialization;
                if (_lifetime.IsCancellationRequested) return;
                var core = browser.CoreWebView2;
                core.Settings.IsStatusBarEnabled = false;
                core.NavigationStarting += (_, args) => {
                    if (OperatorEmbeddedNavigation.IsApplication(args.Uri)) return;
                    args.Cancel = true;
                    OpenReference(args.Uri, args.IsUserInitiated);
                };
                core.NewWindowRequested += (_, args) => {
                    args.Handled = true;
                    OpenReference(args.Uri, args.IsUserInitiated);
                };
                core.PermissionRequested += (_, args) => {
                    if (!OperatorEmbeddedNavigation.IsApplication(args.Uri)) args.State = CoreWebView2PermissionState.Deny;
                };
                core.ProcessFailed += (_, __) => Dispatcher.BeginInvoke(new Action(() => {
                    if (_lifetime.IsCancellationRequested) return;
                    DisposeBrowser();
                    ShowMessage("The conversation window stopped responding. Your task remains saved. Reopen it to continue.", true);
                }));
                core.Navigate(url.AbsoluteUri);
            }
            catch (Exception error)
            {
                DisposeBrowser();
                if (!_lifetime.IsCancellationRequested)
                    ShowMessage("Operator could not open. " + error.Message, true);
            }
            finally { _opening = false; }
        }

        private void OpenReference(string value, bool userInitiated)
        {
            if (!OperatorEmbeddedNavigation.IsUserReference(value, userInitiated)) return;
            Dispatcher.BeginInvoke(new Action(() => {
                if (_lifetime.IsCancellationRequested) return;
                try { Process.Start(new ProcessStartInfo(value) { UseShellExecute = true }); }
                catch { /* The conversation remains usable if no browser is configured. */ }
            }));
        }

        private void ShowMessage(string message, bool retry)
        {
            var panel = new StackPanel { Margin = new Thickness(20), VerticalAlignment = VerticalAlignment.Center };
            panel.Children.Add(new TextBlock { Text = message, TextWrapping = TextWrapping.Wrap, FontSize = 14, Foreground = Brushes.DimGray });
            if (retry)
            {
                var button = new Button { Content = "Try again", Margin = new Thickness(0, 14, 0, 0), Padding = new Thickness(12, 6, 12, 6), HorizontalAlignment = HorizontalAlignment.Left };
                button.Click += async (_, __) => await OpenAsync();
                panel.Children.Add(button);
                var desktop = new Button { Content = "Open Operator Desktop", Margin = new Thickness(0, 8, 0, 0), Padding = new Thickness(12, 6, 12, 6), HorizontalAlignment = HorizontalAlignment.Left };
                desktop.Click += (_, __) => { if (!OperatorDesktopLauncher.TryLaunch(out var detail)) ShowMessage(detail, true); };
                panel.Children.Add(desktop);
            }
            _root.Children.Clear();
            _root.Children.Add(panel);
        }

        private void DisposeBrowser()
        {
            var browser = _browser;
            _browser = null;
            if (browser != null) { _root.Children.Remove(browser); browser.Dispose(); }
        }

        public static void Shutdown()
        {
            var current = Current;
            Current = null;
            if (current == null) return;
            current._lifetime.Cancel();
            current.DisposeBrowser();
        }
    }
}
