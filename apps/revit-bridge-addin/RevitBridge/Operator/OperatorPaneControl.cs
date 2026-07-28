using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Net.Http;
using System.Net.Http.Headers;
using System.Net.Sockets;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Threading;
using System.Threading.Tasks;
using System.Drawing;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Media;
using System.Windows.Media.Imaging;
using MediaColor = System.Windows.Media.Color;
using Microsoft.Win32;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.Wpf;
using Autodesk.Revit.UI.Selection;
using RevitBridge.Common;
using RevitBridge.Handlers;
using RevitBridge.Services;

namespace RevitBridge.Operator
{
    public sealed class OperatorPaneControl : UserControl
    {
        private static readonly TimeSpan WebView2InitializationTimeout = TimeSpan.FromSeconds(15);

        private sealed class UiEnvelope
        {
            public string? Version { get; set; }
            public string? Type { get; set; }
            public JsonElement Payload { get; set; }
        }

        private readonly RevitEventService _eventService;
        private readonly Uri _backendBaseUri;
        private readonly OperatorAuthSession _authSession;
        private readonly OperatorBackendClient _backendClient;
        private readonly OperatorActionRunner _actionRunner;
        private readonly SemaphoreSlim _chatLock = new SemaphoreSlim(1, 1);
        private string? _sessionId;
        private OperatorJsonlLogger? _logger;
        private OperatorProactivityService? _proactivity;
        private bool _proactivityStarted;
        private OperatorApprovalMode _approvalMode = OperatorApprovalMode.Yolo;
        private string _reasoningEffort = "medium";
        private string _brainRoute = "direct";
        private JsonNode? _speedSettings = DefaultSpeedSettingsNode();
        private readonly System.Collections.Generic.Dictionary<string, OperatorActionCall> _pendingApprovals =
            new System.Collections.Generic.Dictionary<string, OperatorActionCall>(StringComparer.OrdinalIgnoreCase);
        private readonly System.Collections.Generic.Dictionary<string, OperatorTurnState> _turnByApprovalActionId =
            new System.Collections.Generic.Dictionary<string, OperatorTurnState>(StringComparer.OrdinalIgnoreCase);
        private OperatorTurnState? _activeTurn;
        private CancellationTokenSource? _activeTurnCts;
        private volatile bool _turnBusy;
        private string? _queuedSendMessageId;
        private string? _queuedSendText;
        private readonly SemaphoreSlim _revitBatchWorkerLock = new SemaphoreSlim(1, 1);
        private System.Threading.Timer? _revitBatchWorkerTimer;
        private volatile bool _revitBatchWorkerStarted;
        private readonly string _revitBatchExecutorId = $"{Environment.MachineName}-revit-pane-{Process.GetCurrentProcess().Id}";

        private readonly HashSet<string> _activeChatScreenshareFiles = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        private static readonly TimeSpan ScreenshareTtl = TimeSpan.FromHours(1);

        private static JsonNode? DefaultSpeedSettingsNode()
        {
            return JsonNode.Parse("{\"speed_mode\":true,\"split_planner_executor\":true,\"planner_model\":\"gpt-5.6-sol\",\"planner_reasoning_effort\":\"medium\",\"executor_model\":\"gpt-5.6-terra\",\"executor_reasoning_effort\":\"medium\",\"force_planner\":false,\"force_executor\":false,\"context_diet\":true,\"max_recent_turns\":8,\"include_full_revit_state\":false,\"include_screenshot_every_turn\":false,\"verbose_tool_results\":false,\"batch_execution\":false,\"persistent_session_mode\":false}");
        }

        // "Interrupt and continue" support: when the user sends a message during an active tool loop,
        // we cancel the in-flight step and then resume the same turn with this text as the next backend input.
        private readonly object _interjectGate = new object();
        private OperatorTurnState? _pendingInterjectTurn;
        private string? _pendingInterjectMessageId;
        private string? _pendingInterjectText;
        private volatile bool _webViewReady;
        private bool _initialized;

        private sealed class OperatorTurnState
        {
            public string SessionId { get; set; } = "";
            public string RootMessageId { get; set; } = "";
            public object? Context { get; set; }
            public int Step { get; set; }
            public int PendingApprovals { get; set; }
            public bool AwaitingApproval { get; set; }
            public System.Collections.Generic.List<OperatorUserAttachment>? UserAttachments { get; set; }
            public System.Collections.Generic.List<OperatorToolResult> PendingToolResults { get; } =
                new System.Collections.Generic.List<OperatorToolResult>();

            // Deterministic Plan→Apply→Verify support:
            // Capture/verify actions are deferred until after all write actions (and approvals) complete.
            public System.Collections.Generic.List<OperatorActionCall> DeferredActions { get; } =
                new System.Collections.Generic.List<OperatorActionCall>();
            public bool WriteAppliedInStep { get; set; }

            // Loop guard: detect repeated, no-progress action plans to avoid burning max-step budget.
            public string LastActionPlanSignature { get; set; } = "";
            public int RepeatedActionPlanCount { get; set; }
            public int VisibleAssistantProgressCount { get; set; }
            public bool DryRunOnly { get; set; }
            public bool DryRunMutationAttempted { get; set; }
            public bool DryRunOnlyBlockedAction { get; set; }
            public bool DryRunOnlyStopped { get; set; }
        }

        private Grid? _rootGrid;
        private FrameworkElement? _mainSurface;
        private Border? _toolPaneRoot;
        private Border? _toolPaneBody;
        private ColumnDefinition? _toolPaneColumn;
        private TextBlock? _toolPaneTitle;
        private WebView2? _toolPaneWebView;
        private OperatorToolPopupWindow? _toolPopupWindow;
        private OperatorToolHostSession? _activeToolSession;
        private OperatorToolHostOpenRequest? _activeToolRequest;
        private WebView2? _webView;
        private OperatorFallbackControl? _fallback;

        public OperatorPaneControl(RevitEventService eventService)
        {
            _eventService = eventService;
            _backendBaseUri = OperatorBackendConfig.GetBaseUri();
            _authSession = new OperatorAuthSession();
            _backendClient = new OperatorBackendClient(_backendBaseUri, _authSession);
            _actionRunner = new OperatorActionRunner(_eventService);
            SetMainSurface(new TextBlock { Text = "Loading Operator...", Margin = new Thickness(8) });
            Loaded += (_, __) => _ = InitializeAsync();
            Unloaded += (_, __) =>
            {
                try { _proactivity?.Dispose(); } catch { }
                try { _revitBatchWorkerTimer?.Dispose(); } catch { }
                try { _toolPopupWindow?.Close(); } catch { }
            };
        }

        private void SetMainSurface(FrameworkElement element)
        {
            _mainSurface = element;
            RefreshRootLayout();
        }

        private void RefreshRootLayout()
        {
            if (_rootGrid == null)
            {
                _rootGrid = new Grid();
                _toolPaneColumn = new ColumnDefinition { Width = new GridLength(0) };
                _rootGrid.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
                _rootGrid.ColumnDefinitions.Add(_toolPaneColumn);
                Content = _rootGrid;
            }

            _rootGrid.Children.Clear();
            if (_mainSurface != null)
            {
                Grid.SetColumn(_mainSurface, 0);
                _rootGrid.Children.Add(_mainSurface);
            }

            var showToolPane = _toolPaneRoot != null && _toolPaneRoot.Visibility == Visibility.Visible;
            if (_toolPaneColumn != null)
                _toolPaneColumn.Width = showToolPane ? new GridLength(0.44, GridUnitType.Star) : new GridLength(0);

            if (showToolPane && _toolPaneRoot != null)
            {
                Grid.SetColumn(_toolPaneRoot, 1);
                _rootGrid.Children.Add(_toolPaneRoot);
            }
        }

        private Border EnsureToolPane()
        {
            if (_toolPaneRoot != null) return _toolPaneRoot;

            var closeButton = new Button
            {
                Content = "Close",
                Padding = new Thickness(8, 4, 8, 4),
                Margin = new Thickness(8, 0, 0, 0)
            };
            closeButton.Click += (_, __) => _ = CloseToolHostAsync(target: "pane");

            var popupButton = new Button
            {
                Content = "Pop out",
                Padding = new Thickness(8, 4, 8, 4),
                Margin = new Thickness(8, 0, 0, 0)
            };
            popupButton.Click += (_, __) => _ = PopOutActiveToolAsync();

            _toolPaneTitle = new TextBlock
            {
                Text = "Tool UI",
                FontWeight = FontWeights.SemiBold,
                VerticalAlignment = VerticalAlignment.Center,
                TextTrimming = TextTrimming.CharacterEllipsis
            };

            var header = new DockPanel
            {
                LastChildFill = false,
                Margin = new Thickness(10, 8, 10, 8)
            };
            DockPanel.SetDock(closeButton, Dock.Right);
            DockPanel.SetDock(popupButton, Dock.Right);
            header.Children.Add(closeButton);
            header.Children.Add(popupButton);
            header.Children.Add(_toolPaneTitle);

            _toolPaneWebView = new WebView2();
            _toolPaneBody = new Border
            {
                BorderThickness = new Thickness(0, 1, 0, 0),
                BorderBrush = new SolidColorBrush(MediaColor.FromArgb(48, 127, 127, 127)),
                Child = _toolPaneWebView
            };

            var panel = new DockPanel();
            DockPanel.SetDock(header, Dock.Top);
            panel.Children.Add(header);
            panel.Children.Add(_toolPaneBody);

            _toolPaneRoot = new Border
            {
                BorderThickness = new Thickness(1, 0, 0, 0),
                BorderBrush = new SolidColorBrush(MediaColor.FromArgb(48, 127, 127, 127)),
                Background = new SolidColorBrush(MediaColor.FromArgb(20, 127, 127, 127)),
                Child = panel,
                Visibility = Visibility.Collapsed
            };
            return _toolPaneRoot;
        }

        private void StartProactivityIfNeeded()
        {
            if (_proactivityStarted) return;
            _proactivityStarted = true;
            _proactivity = new OperatorProactivityService(
                _eventService,
                _backendClient,
                getSessionId: () => _sessionId,
                getLogger: () => _logger,
                appendChat: (role, text, messageId) => Ui(() => AppendChat(role, text, messageId)),
                handleNotification: HandleProactiveNotification);
            _proactivity.Start();
            EnsureRevitBatchWorkerStarted();
        }

        private bool HandleProactiveNotification(OperatorBackendClient.OperatorNotification n)
        {
            var type = (n.Type ?? "").Trim().ToLowerInvariant();
            if (type.StartsWith("revit.batch.", StringComparison.Ordinal))
            {
                var text = (n.Text ?? "").Trim();
                if (!string.IsNullOrWhiteSpace(text))
                {
                    Ui(() => AppendChat("assistant", text, $"notify:{n.Id}"));
                }
                return true;
            }

            if (!string.Equals(type, "codex.tool_call", StringComparison.Ordinal)) return false;

            var tool = TryGetNotificationString(n.Payload, "tool") ?? "tool";
            var server = TryGetNotificationString(n.Payload, "server") ?? "revit_operator";
            var status = TryGetNotificationString(n.Payload, "status") ?? "";
            var err = TryGetNotificationString(n.Payload, "error") ?? "";
            var actionId = $"notify:{n.Id}";
            var path = $"mcp://{server}/{tool}";
            var title = $"MCP {tool}";
            var args = TryGetNotificationObject(n.Payload, "arguments");
            var result = TryGetNotificationObject(n.Payload, "result");
            var uiStatus = MapCodexToolStatus(status, err);

            Ui(() =>
            {
                AddAction(actionId, title, path, args);
                UpdateActionStatus(actionId, uiStatus, string.IsNullOrWhiteSpace(err) ? null : err);
                if (result != null) SetActionResult(actionId, result);
            });
            return true;
        }

        private static string MapCodexToolStatus(string? statusRaw, string? err)
        {
            if (!string.IsNullOrWhiteSpace(err)) return "failed";
            var status = (statusRaw ?? "").Trim().ToLowerInvariant();
            if (status == "success" || status == "ok" || status == "done" || status == "completed") return "done";
            if (status == "failed" || status == "error" || status == "cancelled") return "failed";
            if (status == "running" || status == "in_progress") return "running";
            return string.IsNullOrWhiteSpace(status) ? "done" : status;
        }

        private static string? TryGetNotificationString(JsonElement payload, string name)
        {
            try
            {
                if (payload.ValueKind != JsonValueKind.Object) return null;
                if (!payload.TryGetProperty(name, out var p) || p.ValueKind != JsonValueKind.String) return null;
                return p.GetString();
            }
            catch
            {
                return null;
            }
        }

        private static object? TryGetNotificationObject(JsonElement payload, string name)
        {
            try
            {
                if (payload.ValueKind != JsonValueKind.Object) return null;
                if (!payload.TryGetProperty(name, out var p)) return null;
                if (p.ValueKind == JsonValueKind.Null || p.ValueKind == JsonValueKind.Undefined) return null;
                return JsonSerializer.Deserialize<object>(p.GetRawText(), OperatorUiProtocol.JsonOptions);
            }
            catch
            {
                return null;
            }
        }

        private async Task InitializeAsync()
        {
            if (_initialized) return;
            _initialized = true;

            // New add-in session: purge previous-session screenshare uploads and compact stale index entries.
            TryCleanupScreenshareUploads(deleteAllScreenshares: true, ttl: null);

            var disableWebView2 = string.Equals(Environment.GetEnvironmentVariable("OPERATOR_DISABLE_WEBVIEW2"), "1", StringComparison.OrdinalIgnoreCase);

            if (!disableWebView2 && TryCreateWebView())
            {
                try
                {
                    var userDataFolder = Path.Combine(
                        Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                        "RevitOperator",
                        "WebView2");
                    Directory.CreateDirectory(userDataFolder);
                    _webView!.CreationProperties = new CoreWebView2CreationProperties
                    {
                        UserDataFolder = userDataFolder
                    };

                    var webViewInitialization = _webView!.EnsureCoreWebView2Async();
                    var completed = await Task.WhenAny(
                        webViewInitialization,
                        Task.Delay(WebView2InitializationTimeout));
                    if (!ReferenceEquals(completed, webViewInitialization))
                    {
                        throw new TimeoutException(
                            $"WebView2 initialization did not complete within {WebView2InitializationTimeout.TotalSeconds:0} seconds.");
                    }

                    await webViewInitialization;
                    _webViewReady = true;
                    _webView.CoreWebView2.WebMessageReceived += OnWebMessageReceived;
                    _webView.CoreWebView2.PermissionRequested += (_, args) =>
                    {
                        try
                        {
                            if (args.PermissionKind == CoreWebView2PermissionKind.Microphone)
                            {
                                args.State = CoreWebView2PermissionState.Allow;
                                args.Handled = true;
                            }
                        }
                        catch { }
                    };
                     _webView.NavigationCompleted += (_, __) =>
                     {
                         try
                         {
                             PostToUi("chat.append", new { role = "system", text = $"Operator ready. Backend: {_backendBaseUri}" });
                             PostToUi("policy.current", new { mode = UiModeString(_approvalMode) });
                              PostReasoningEffortToUi();
                              EnsureNativeApiPolicyForApprovalMode(postToUi: true, announceChat: false);
                             try
                             {
                                 var status = EnsureWriteGrantForApprovalMode(forceIssue: false);
                                 PostWriteGrantStatusToUi(status);
                             }
                             catch { }
                             PostAuthStateToUi();
                             PostToUi("tools.list", new { tools = OperatorToolManifest.Tools });
                             PostToUi("loop.state", new { running = _activeTurn != null });
                         }
                         catch { }
                     };

                    // getUserMedia requires a secure context. NavigateToString uses about:blank origin, where media APIs can be unavailable.
                    // Serve the HTML from a virtual https origin mapped to a local folder to enable microphone capture.
                    if (!TryNavigateWebUiViaVirtualHost(_webView.CoreWebView2))
                    {
                        _webView.NavigateToString(OperatorWebUiHtml.Html);
                    }
                    return;
                }
                catch (Exception ex)
                {
                    ShowFallbackUi($"WebView2 init failed: {ex.GetType().Name}: {ex.Message}");
                    return;
                }
            }

            ShowFallbackUi(disableWebView2
                ? "WebView2 is disabled by OPERATOR_DISABLE_WEBVIEW2; using the native WPF fallback UI."
                : "WebView2 could not be created; using the native WPF fallback UI.");
        }

        private void ShowFallbackUi(string reason)
        {
            _webViewReady = false;
            try { _webView?.Dispose(); } catch { }
            _webView = null;

            _fallback = new OperatorFallbackControl();
            _fallback.ChatSend += (_, e) => OnChatSend(e.MessageId, e.Text, e.Attachments, shareWithAgent: true, autoOpenLatestAttachment: false, _reasoningEffort);
            _fallback.AttachmentRequested += (_, __) => _ = HandleFilePickAsync();
            _fallback.NewChatRequested += (_, __) => _ = ResetChatAsync();
            _fallback.CancelRequested += (_, __) => _ = CancelActiveTurnAsync("USER_CANCELLED");
            SetMainSurface(_fallback);
            _fallback.AppendChat("system", reason);
            _fallback.AppendChat("system", "The fallback remains fully usable for chat and Revit actions. Verify Microsoft Edge WebView2 Runtime and policy before the next launch.");
            _fallback.AppendChat("system", $"Backend: {_backendBaseUri}");

            TryLogPaneInitialization(reason);
        }

        private static void TryLogPaneInitialization(string message)
        {
            try
            {
                var logDir = Path.Combine(
                    Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                    "RevitOperator",
                    "Logs");
                Directory.CreateDirectory(logDir);
                var logPath = Path.Combine(logDir, "operator-pane-initialization.log");
                File.AppendAllText(
                    logPath,
                    $"[{DateTimeOffset.Now:O}] {message}{Environment.NewLine}",
                    Encoding.UTF8);
            }
            catch
            {
                // Pane diagnostics must never prevent the fallback UI from loading.
            }
        }

        private bool TryCreateWebView()
        {
            try
            {
                _webView = new WebView2();
                _webView.AllowDrop = true;
                _webView.DragOver += (_, e) =>
                {
                    try
                    {
                        if (e.Data != null && e.Data.GetDataPresent(DataFormats.FileDrop))
                        {
                            e.Effects = DragDropEffects.Copy;
                            e.Handled = true;
                        }
                    }
                    catch { }
                };
                _webView.Drop += (_, e) =>
                {
                    try
                    {
                        if (e.Data == null || !e.Data.GetDataPresent(DataFormats.FileDrop)) return;
                        var files = e.Data.GetData(DataFormats.FileDrop) as string[];
                        if (files == null || files.Length == 0) return;
                        _ = HandleIncomingFilesAsync(files, source: "drop");
                        e.Handled = true;
                    }
                    catch { }
                };
                SetMainSurface(_webView);
                return true;
            }
            catch
            {
                _webView = null;
                return false;
            }
        }

        private bool TryNavigateWebUiViaVirtualHost(CoreWebView2 core)
        {
            try
            {
                var folder = Path.Combine(
                    Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                    "RevitOperator",
                    "WebUi");
                Directory.CreateDirectory(folder);

                var indexPath = Path.Combine(folder, "index.html");
                var html = OperatorWebUiHtml.Html;
                try
                {
                    // Avoid rewriting if unchanged, but keep it simple and robust.
                    if (!File.Exists(indexPath) || !string.Equals(File.ReadAllText(indexPath, Encoding.UTF8), html, StringComparison.Ordinal))
                        File.WriteAllText(indexPath, html, Encoding.UTF8);
                }
                catch
                {
                    // Best-effort: if we can't write, fall back to NavigateToString.
                    return false;
                }

                const string host = "revitoperator.local";
                core.SetVirtualHostNameToFolderMapping(host, folder, CoreWebView2HostResourceAccessKind.Allow);
                core.Navigate($"https://{host}/index.html");
                return true;
            }
            catch
            {
                return false;
            }
        }

        private void OnWebMessageReceived(object? sender, CoreWebView2WebMessageReceivedEventArgs e)
        {
            try
            {
                var env = JsonSerializer.Deserialize<UiEnvelope>(e.WebMessageAsJson, OperatorUiProtocol.JsonOptions);
                if (env?.Version != OperatorUiProtocol.Version) return;
                if (env.Type == "chat.send")
                {
                    var messageId = env.Payload.TryGetProperty("messageId", out var mid) ? mid.GetString() : null;
                    var text = env.Payload.TryGetProperty("text", out var t) ? t.GetString() : null;
                    var reasoningEffort = _reasoningEffort;
                    System.Collections.Generic.List<OperatorUserAttachment>? attachments = null;
                    var shareWithAgent = true;
                    var autoOpenLatestAttachment = false;
                    try
                    {
                        if (env.Payload.TryGetProperty("attachments", out var a) && a.ValueKind == JsonValueKind.Array)
                        {
                            attachments = JsonSerializer.Deserialize<System.Collections.Generic.List<OperatorUserAttachment>>(a.GetRawText(), OperatorUiProtocol.JsonOptions);
                        }
                    }
                    catch
                    {
                        attachments = null;
                    }

                    try
                    {
                        if (env.Payload.TryGetProperty("attachment_policy", out var pol) && pol.ValueKind == JsonValueKind.Object)
                        {
                            if (pol.TryGetProperty("share_with_agent", out var s) && (s.ValueKind == JsonValueKind.True || s.ValueKind == JsonValueKind.False))
                                shareWithAgent = s.GetBoolean();
                            if (pol.TryGetProperty("auto_open_latest_attachment", out var ao) && (ao.ValueKind == JsonValueKind.True || ao.ValueKind == JsonValueKind.False))
                                autoOpenLatestAttachment = ao.GetBoolean();
                        }
                    }
                    catch { }

                    try
                    {
                        if (env.Payload.TryGetProperty("reasoning_effort", out var re) && re.ValueKind == JsonValueKind.String)
                        {
                            reasoningEffort = NormalizeReasoningEffort(re.GetString());
                            _reasoningEffort = reasoningEffort;
                        }
                    }
                    catch { }

                    try
                    {
                        if (env.Payload.TryGetProperty("speed_settings", out var ss) && ss.ValueKind == JsonValueKind.Object)
                        {
                            _speedSettings = JsonNode.Parse(ss.GetRawText());
                        }
                    }
                    catch { }

                    try
                    {
                        if (env.Payload.TryGetProperty("brain_route", out var br) && br.ValueKind == JsonValueKind.String)
                        {
                            _brainRoute = string.Equals(br.GetString(), "direct", StringComparison.OrdinalIgnoreCase)
                                ? "direct"
                                : "auto";
                        }
                    }
                    catch { _brainRoute = "direct"; }

                    if (!string.IsNullOrWhiteSpace(messageId) && (attachments != null && attachments.Count > 0 || !string.IsNullOrWhiteSpace(text)))
                    {
                        OnChatSend(messageId!, text ?? "", attachments, shareWithAgent, autoOpenLatestAttachment, reasoningEffort);
                    }
                }
                else if (env.Type == "session.new")
                {
                    _ = ResetChatAsync();
                }
                else if (env.Type == "policy.set")
                {
                    var mode = env.Payload.TryGetProperty("mode", out var m) ? m.GetString() : null;
                    if (string.Equals(mode, "safe", StringComparison.OrdinalIgnoreCase)) _approvalMode = OperatorApprovalMode.Safe;
                    else if (string.Equals(mode, "session", StringComparison.OrdinalIgnoreCase)) _approvalMode = OperatorApprovalMode.AllowWritesThisSession;
                    else if (string.Equals(mode, "yolo", StringComparison.OrdinalIgnoreCase)) _approvalMode = OperatorApprovalMode.Yolo;

                      Ui(() => PostToUi("policy.current", new { mode = UiModeString(_approvalMode) }));
                      Ui(() => AppendChat("system", $"Approval mode: {UiModeString(_approvalMode)}", null));

                      // Bridge-layer write grant: used by MCP/direct tool execution (server-side enforcement).
                      try
                    {
                        var st = EnsureWriteGrantForApprovalMode(forceIssue: true);
                        if (_approvalMode == OperatorApprovalMode.Safe)
                        {
                            Ui(() => AppendChat("system", "Write grant cleared (safe mode).", null));
                        }
                        else if (st.Active)
                        {
                            Ui(() => AppendChat("system", $"Write grant active ({st.Mode}) until {st.ExpiresAtUtc?.ToLocalTime().ToString("t")}.", null));
                        }
                        Ui(() => PostWriteGrantStatusToUi(st));
                    }
                    catch
                      {
                          // ignore; write grants are best-effort UX and must not break the pane
                      }

                      Ui(() => EnsureNativeApiPolicyForApprovalMode(postToUi: true, announceChat: true));

                      _ = _logger?.LogAsync("policy.set", new { mode = _approvalMode.ToString() }, CancellationToken.None);
                      _ = RunPendingApprovalsAsync();
                }
                else if (env.Type == "reasoning.set")
                {
                    var effort = env.Payload.TryGetProperty("effort", out var e2) ? e2.GetString() : null;
                    _reasoningEffort = NormalizeReasoningEffort(effort);
                    Ui(() => PostReasoningEffortToUi());
                }
                else if (env.Type == "native_api_policy.set")
                {
                    var profile = env.Payload.TryGetProperty("profile", out var p) ? p.GetString() : null;
                    object result = OperatorNativeApiPolicy.SetPolicy(profile, maxRisk: null, allowMutating: null, blockFreezeRisk: null, maxResults: null, maxInvocationParams: null);
                    Ui(() =>
                    {
                        PostNativeApiPolicyToUi();
                        try
                        {
                            var json = JsonSerializer.Serialize(result, OperatorUiProtocol.JsonOptions);
                            using var doc = JsonDocument.Parse(string.IsNullOrWhiteSpace(json) ? "{}" : json);
                            var root = doc.RootElement;
                            var ok = root.TryGetProperty("ok", out var okEl) && okEl.ValueKind == JsonValueKind.True;
                            var err = root.TryGetProperty("error", out var errEl) && errEl.ValueKind == JsonValueKind.String ? (errEl.GetString() ?? "") : "";
                            if (!ok && !string.IsNullOrWhiteSpace(err))
                            {
                                AppendChat("system", "Native API policy unchanged: " + err, null);
                            }
                            else
                            {
                                var prof = profile;
                                try
                                {
                                    var status = OperatorNativeApiPolicy.GetStatus();
                                    var stJson = JsonSerializer.Serialize(status, OperatorUiProtocol.JsonOptions);
                                    using var stDoc = JsonDocument.Parse(string.IsNullOrWhiteSpace(stJson) ? "{}" : stJson);
                                    if (stDoc.RootElement.TryGetProperty("profile", out var profEl) && profEl.ValueKind == JsonValueKind.String)
                                        prof = profEl.GetString();
                                }
                                catch { }
                                AppendChat("system", "Native API profile: " + (string.IsNullOrWhiteSpace(prof) ? "broad" : prof), null);
                            }
                        }
                        catch
                        {
                            AppendChat("system", "Native API policy updated.", null);
                        }
                    });
                    _ = _logger?.LogAsync("native_api_policy.set", new { profile }, CancellationToken.None);
                }
                else if (env.Type == "action.approve")
                {
                    var actionId = env.Payload.TryGetProperty("actionId", out var aid) ? aid.GetString() : null;
                    var grant = env.Payload.TryGetProperty("grant", out var g) ? g.GetString() : null;
                    if (!string.IsNullOrWhiteSpace(actionId))
                    {
                        if (string.Equals(grant, "session", StringComparison.OrdinalIgnoreCase)) _approvalMode = OperatorApprovalMode.AllowWritesThisSession;
                        else if (string.Equals(grant, "yolo", StringComparison.OrdinalIgnoreCase)) _approvalMode = OperatorApprovalMode.Yolo;

                        Ui(() => PostToUi("policy.current", new { mode = UiModeString(_approvalMode) }));

                        // Also mint a bridge-layer write grant matching the UI approval intent.
                        try
                        {
                            OperatorWriteGrantStatus st;
                            if (string.Equals(grant, "once", StringComparison.OrdinalIgnoreCase))
                            {
                                st = OperatorWriteGrant.Issue(OperatorWriteGrantMode.Once, TimeSpan.FromMinutes(10));
                                Ui(() => AppendChat("system", $"Write grant active ({st.Mode}) for one write.", null));
                            }
                            else
                            {
                                st = EnsureWriteGrantForApprovalMode(forceIssue: true);
                                if (st.Active)
                                    Ui(() => AppendChat("system", $"Write grant active ({st.Mode}) until {st.ExpiresAtUtc?.ToLocalTime().ToString("t")}.", null));
                            }
                          Ui(() => PostWriteGrantStatusToUi(st));
                          Ui(() => EnsureNativeApiPolicyForApprovalMode(postToUi: true, announceChat: true));
                      }
                      catch
                      {
                            // ignore
                        }

                        _ = _logger?.LogAsync("action.approve", new { action_id = actionId, grant, mode = _approvalMode.ToString() }, CancellationToken.None);
                        _ = ApproveAndRunAsync(actionId!);
                    }
                }
                else if (env.Type == "action.body.update")
                {
                    var actionId = env.Payload.TryGetProperty("actionId", out var aid) ? aid.GetString() : null;
                    if (string.IsNullOrWhiteSpace(actionId)) return;
                    if (!_pendingApprovals.TryGetValue(actionId!, out var action)) return;

                    if (!env.Payload.TryGetProperty("body", out var body)) return;
                    action.Body = body;

                    var title = $"{(action.Method ?? "").Trim().ToUpperInvariant()} {action.Path}";
                    var risk = GetActionRisk(action);
                    Ui(() => AddAction(actionId!, title, action.Path, action.Body, approvalRequired: true, risk: risk));
                    Ui(() => UpdateActionStatus(actionId!, "needs_approval", null));
                }
                else if (env.Type == "voice.transcribe")
                {
                    var requestId = env.Payload.TryGetProperty("requestId", out var rid) ? rid.GetString() : null;
                    var audioBase64 = env.Payload.TryGetProperty("audioBase64", out var ab) ? ab.GetString() : null;
                    var format = env.Payload.TryGetProperty("format", out var f) ? f.GetString() : "wav";

                    if (!string.IsNullOrWhiteSpace(requestId) && !string.IsNullOrWhiteSpace(audioBase64))
                    {
                        _ = HandleVoiceTranscribeAsync(requestId!, audioBase64!, format ?? "wav");
                    }
                }
                else if (env.Type == "voice.speak")
                {
                    var requestId = env.Payload.TryGetProperty("requestId", out var rid) ? rid.GetString() : null;
                    var text = env.Payload.TryGetProperty("text", out var t) ? t.GetString() : null;
                    var format = env.Payload.TryGetProperty("format", out var f) ? f.GetString() : "mp3";
                    var voice = env.Payload.TryGetProperty("voice", out var v) ? v.GetString() : null;

                    if (!string.IsNullOrWhiteSpace(requestId) && !string.IsNullOrWhiteSpace(text))
                    {
                        _ = HandleVoiceSpeakAsync(requestId!, text!, format ?? "mp3", voice);
                    }
                }
                else if (env.Type == "loop.cancel")
                {
                    _ = CancelActiveTurnAsync("USER_CANCELLED");
                }
                else if (env.Type == "feedback.submit")
                {
                    var chatId = env.Payload.TryGetProperty("chatId", out var cid) ? cid.GetString() : null;
                    var rating = env.Payload.TryGetProperty("rating", out var rr) ? rr.GetString() : null;
                    var note = env.Payload.TryGetProperty("note", out var nn) ? nn.GetString() : null;

                    var rememberPreference = false;
                    try
                    {
                        if (env.Payload.TryGetProperty("rememberPreference", out var rp) && (rp.ValueKind == JsonValueKind.True || rp.ValueKind == JsonValueKind.False))
                            rememberPreference = rp.GetBoolean();
                    }
                    catch { rememberPreference = false; }

                    var queueUpload = false;
                    try
                    {
                        if (env.Payload.TryGetProperty("queueUpload", out var qu) && (qu.ValueKind == JsonValueKind.True || qu.ValueKind == JsonValueKind.False))
                            queueUpload = qu.GetBoolean();
                    }
                    catch { queueUpload = false; }

                    var devApplyRepoChanges = false;
                    try
                    {
                        if (env.Payload.TryGetProperty("devApplyRepoChanges", out var da) && (da.ValueKind == JsonValueKind.True || da.ValueKind == JsonValueKind.False))
                            devApplyRepoChanges = da.GetBoolean();
                    }
                    catch { devApplyRepoChanges = false; }

                    if (!string.IsNullOrWhiteSpace(rating))
                    {
                        _ = HandleFeedbackSubmitAsync(chatId, rating!, note, rememberPreference, queueUpload, devApplyRepoChanges);
                    }
                }
                else if (env.Type == "cloud_upload.load")
                {
                    _ = HandleCloudUploadLoadAsync();
                }
                else if (env.Type == "cloud_upload.save")
                {
                    var uploadUrl = env.Payload.TryGetProperty("upload_url", out var uu) && uu.ValueKind == JsonValueKind.String ? uu.GetString() : null;
                    var mode = env.Payload.TryGetProperty("mode", out var mm) && mm.ValueKind == JsonValueKind.String ? mm.GetString() : null;

                    var uploadTokenProvided = env.Payload.TryGetProperty("upload_token", out var ut);
                    string? uploadToken = null;
                    if (uploadTokenProvided)
                    {
                        if (ut.ValueKind == JsonValueKind.String) uploadToken = ut.GetString();
                        else if (ut.ValueKind == JsonValueKind.Null) uploadToken = null;
                    }

                    _ = HandleCloudUploadSaveAsync(uploadUrl, mode, uploadTokenProvided, uploadToken);
                }
                else if (env.Type == "auth.login")
                {
                    var email = env.Payload.TryGetProperty("email", out var ee) && ee.ValueKind == JsonValueKind.String ? ee.GetString() : null;
                    var password = env.Payload.TryGetProperty("password", out var pp) && pp.ValueKind == JsonValueKind.String ? pp.GetString() : null;
                    _ = HandleAuthLoginAsync(email, password);
                }
                else if (env.Type == "auth.refresh")
                {
                    _ = HandleAuthRefreshAsync();
                }
                else if (env.Type == "auth.signout")
                {
                    HandleAuthSignOut();
                }
                else if (env.Type == "auth.state.request")
                {
                    Ui(() => PostAuthStateToUi());
                }
                else if (env.Type == "shell.openFolder")
                {
                    var p = env.Payload.TryGetProperty("path", out var pp) ? pp.GetString() : null;
                    try
                    {
                        OpenWorkspacePathInExplorer(p);
                    }
                    catch (Exception ex)
                    {
                        Ui(() => AppendChat("system", "Open folder failed: " + ex.Message, null));
                    }
                }
                else if (env.Type == "shell.openPath")
                {
                    var p = env.Payload.TryGetProperty("path", out var pp) ? pp.GetString() : null;
                    try
                    {
                        OpenAllowedOutputPath(p);
                    }
                    catch (Exception ex)
                    {
                        Ui(() => AppendChat("system", "Open file failed: " + ex.Message, null));
                    }
                }
                else if (env.Type == "file.pick")
                {
                    _ = HandleFilePickAsync();
                }
                else if (env.Type == "screen.capture")
                {
                    _ = HandleScreenCaptureAsync();
                }
                else if (env.Type == "clipboard.image.attach")
                {
                    var dataBase64 = env.Payload.TryGetProperty("data_base64", out var db) && db.ValueKind == JsonValueKind.String ? db.GetString() : null;
                    var mime = env.Payload.TryGetProperty("mime", out var mm) && mm.ValueKind == JsonValueKind.String ? mm.GetString() : null;
                    _ = HandleClipboardImageAttachAsync(dataBase64, mime);
                }
            }
            catch
            {
                // Ignore malformed UI messages in v0.
            }
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct RECT
        {
            public int Left;
            public int Top;
            public int Right;
            public int Bottom;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct POINT
        {
            public int X;
            public int Y;
        }

        [DllImport("user32.dll")]
        private static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);

        [DllImport("user32.dll")]
        private static extern bool GetCursorPos(out POINT lpPoint);

        private async Task HandleScreenCaptureAsync()
        {
            try
            {
                var cap = await CaptureScreenshareAsync().ConfigureAwait(false);
                var saved = cap.Saved;
                if (saved.Count == 0) return;

                TrackScreenshareFilesForActiveChat(saved);
                TryCleanupScreenshareUploads(deleteAllScreenshares: false, ttl: ScreenshareTtl);

                var attachedText = string.Join("\n", saved.Select(s => "- " + s.RelativePath));
                Ui(() => AppendChat("system", $"Screenshare captured and attached:\n{attachedText}", null));
                Ui(() =>
                {
                    if (_webView?.CoreWebView2 != null)
                    {
                        PostToUi("attachments.added", new
                        {
                            attachments = saved.Select(s => new
                            {
                                id = s.Id,
                                relative_path = s.RelativePath,
                                filename = s.FileName,
                                bytes = s.Bytes,
                                sha256 = s.Sha256,
                                mime = s.Mime,
                                created_at = s.CreatedAt
                            }).ToArray()
                        });
                    }
                });
            }
            catch (Exception ex)
            {
                Ui(() => AppendChat("system", "Screenshare capture failed: " + ex.Message, null));
            }
        }

        private async Task HandleClipboardImageAttachAsync(string? dataBase64, string? mime)
        {
            try
            {
                var b64 = (dataBase64 ?? "").Trim();
                if (string.IsNullOrWhiteSpace(b64)) return;

                byte[] bytes;
                try
                {
                    bytes = Convert.FromBase64String(b64);
                }
                catch
                {
                    throw new Exception("Clipboard image payload is not valid base64.");
                }

                if (bytes.Length <= 0) throw new Exception("Clipboard image payload is empty.");
                if (bytes.Length > 25L * 1024L * 1024L) throw new Exception("Clipboard image is too large (max 25 MB).");

                var saved = await Task.Run(() => SaveClipboardImageToWorkspace(bytes, mime)).ConfigureAwait(false);
                if (saved == null) throw new Exception("Failed to save clipboard image.");
                if (!string.IsNullOrWhiteSpace(saved.FullPath))
                    _activeChatScreenshareFiles.Add(saved.FullPath);
                TryCleanupScreenshareUploads(deleteAllScreenshares: false, ttl: ScreenshareTtl);

                Ui(() =>
                {
                    AppendChat("system", $"Clipboard image attached:\n- {saved.RelativePath}", null);
                    if (_webView?.CoreWebView2 != null)
                    {
                        PostToUi("attachments.added", new
                        {
                            attachments = new[]
                            {
                                new
                                {
                                    id = saved.Id,
                                    relative_path = saved.RelativePath,
                                    filename = saved.FileName,
                                    bytes = saved.Bytes,
                                    sha256 = saved.Sha256,
                                    mime = saved.Mime,
                                    created_at = saved.CreatedAt
                                }
                            }
                        });
                    }
                });
            }
            catch (Exception ex)
            {
                Ui(() => AppendChat("system", "Clipboard attach failed: " + ex.Message, null));
            }
        }

        private async Task HandleFeedbackSubmitAsync(string? chatId, string rating, string? note, bool rememberPreference, bool queueUpload, bool devApplyRepoChanges)
        {
            try
            {
                await EnsureBackendRunningAsync(CancellationToken.None).ConfigureAwait(false);
                var sid = await EnsureSessionAsync().ConfigureAwait(false);
                _logger ??= new OperatorJsonlLogger(sid);

                await _logger.LogAsync("feedback.submit", new
                {
                    backend_session_id = sid,
                    chat_id = chatId,
                    rating = rating,
                    note = note,
                    remember_preference = rememberPreference,
                    queue_upload = queueUpload,
                    dev_apply_repo_changes = devApplyRepoChanges
                }, CancellationToken.None).ConfigureAwait(false);

                var json = await _backendClient.PostFeedbackAsync(
                    sid,
                    chatId ?? "",
                    rating,
                    note,
                    rememberPreference,
                    queueUpload,
                    devApplyRepoChanges,
                    CancellationToken.None).ConfigureAwait(false);

                // Best-effort: show where evidence/memory/queue were written.
                try
                {
                    using var doc = JsonDocument.Parse(json ?? "");
                    var root = doc.RootElement;
                    string daily = root.TryGetProperty("memory_daily_path", out var d) && d.ValueKind == JsonValueKind.String ? d.GetString()! : "";
                    string longterm = root.TryGetProperty("memory_longterm_path", out var l) && l.ValueKind == JsonValueKind.String ? l.GetString()! : "";
                    string qdir = root.TryGetProperty("upload_queue_dir", out var q) && q.ValueKind == JsonValueKind.String ? q.GetString()! : "";
                    string devRunDir = "";
                    if (root.TryGetProperty("dev_autofix", out var da) && da.ValueKind == JsonValueKind.Object)
                    {
                        devRunDir = da.TryGetProperty("run_dir_rel", out var rr) && rr.ValueKind == JsonValueKind.String ? rr.GetString()! : "";
                    }

                    var sb = new StringBuilder();
                    sb.AppendLine("Feedback saved.");
                    if (!string.IsNullOrWhiteSpace(daily) || !string.IsNullOrWhiteSpace(longterm))
                    {
                        sb.AppendLine();
                        sb.AppendLine("Memory:");
                        if (!string.IsNullOrWhiteSpace(daily)) sb.AppendLine("- " + daily);
                        if (!string.IsNullOrWhiteSpace(longterm)) sb.AppendLine("- " + longterm);
                    }
                    if (!string.IsNullOrWhiteSpace(qdir))
                    {
                        sb.AppendLine();
                        sb.AppendLine("[Open upload queue](op://open-folder?path=" + Uri.EscapeDataString(qdir) + ")");
                    }
                    if (!string.IsNullOrWhiteSpace(devRunDir))
                    {
                        sb.AppendLine();
                        sb.AppendLine("[Open dev auto-update run](op://open-folder?path=" + Uri.EscapeDataString(devRunDir) + ")");
                    }
                    Ui(() => AppendChat("system", sb.ToString().Trim(), null));
                }
                catch
                {
                    Ui(() => AppendChat("system", "Feedback saved.", null));
                }
            }
            catch (Exception ex)
            {
                Ui(() => AppendChat("system", "Feedback failed: " + ex.Message, null));
            }
        }

        private async Task HandleCloudUploadLoadAsync()
        {
            try
            {
                await EnsureBackendRunningAsync(CancellationToken.None).ConfigureAwait(false);
                var json = await _backendClient.GetCloudUploadConfigAsync(CancellationToken.None).ConfigureAwait(false);

                Ui(() =>
                {
                    try
                    {
                        using var doc = JsonDocument.Parse(json ?? "");
                        var root = doc.RootElement;
                        var payload = new
                        {
                            upload_url = root.TryGetProperty("upload_url", out var u) && u.ValueKind == JsonValueKind.String ? u.GetString() : null,
                            mode = root.TryGetProperty("mode", out var m) && m.ValueKind == JsonValueKind.String ? m.GetString() : "off",
                            has_token = root.TryGetProperty("has_token", out var ht) && (ht.ValueKind == JsonValueKind.True || ht.ValueKind == JsonValueKind.False)
                                ? ht.GetBoolean()
                                : false
                        };
                        PostToUi("cloud_upload.current", payload);
                    }
                    catch (Exception ex)
                    {
                        PostToUi("cloud_upload.error", new { error = "Cloud settings parse failed: " + ex.Message });
                    }
                });
            }
            catch (Exception ex)
            {
                Ui(() => PostToUi("cloud_upload.error", new { error = ex.Message }));
            }
        }

        private async Task HandleCloudUploadSaveAsync(string? uploadUrl, string? mode, bool uploadTokenProvided, string? uploadToken)
        {
            try
            {
                await EnsureBackendRunningAsync(CancellationToken.None).ConfigureAwait(false);
                var json = await _backendClient.PostCloudUploadConfigAsync(uploadUrl, mode, uploadTokenProvided, uploadToken, CancellationToken.None).ConfigureAwait(false);

                Ui(() =>
                {
                    try
                    {
                        using var doc = JsonDocument.Parse(json ?? "");
                        var root = doc.RootElement;
                        var payload = new
                        {
                            upload_url = root.TryGetProperty("upload_url", out var u) && u.ValueKind == JsonValueKind.String ? u.GetString() : null,
                            mode = root.TryGetProperty("mode", out var m) && m.ValueKind == JsonValueKind.String ? m.GetString() : "off",
                            has_token = root.TryGetProperty("has_token", out var ht) && (ht.ValueKind == JsonValueKind.True || ht.ValueKind == JsonValueKind.False)
                                ? ht.GetBoolean()
                                : false
                        };
                        PostToUi("cloud_upload.saved", payload);
                        AppendChat("system", "Cloud upload settings saved.", null);
                    }
                    catch (Exception ex)
                    {
                        PostToUi("cloud_upload.error", new { error = "Cloud settings save parse failed: " + ex.Message });
                    }
                });
            }
            catch (Exception ex)
            {
                Ui(() => PostToUi("cloud_upload.error", new { error = ex.Message }));
            }
        }

        private async Task HandleAuthLoginAsync(string? email, string? password)
        {
            try
            {
                if (string.IsNullOrWhiteSpace(email) || string.IsNullOrWhiteSpace(password))
                {
                    Ui(() => PostToUi("auth.error", new { error = "Email and password are required." }));
                    return;
                }

                var st = await _authSession.LoginAsync(email.Trim(), password!, CancellationToken.None).ConfigureAwait(false);
                Ui(() =>
                {
                    PostAuthStateToUi(st);
                    AppendChat("system", st.can_chat ? "Signed in." : (st.message ?? "Sign-in completed."), null);
                });
            }
            catch (Exception ex)
            {
                Ui(() =>
                {
                    PostToUi("auth.error", new { error = ex.Message });
                    PostAuthStateToUi();
                });
            }
        }

        private async Task HandleAuthRefreshAsync()
        {
            try
            {
                var st = await _authSession.RefreshAsync(CancellationToken.None).ConfigureAwait(false);
                Ui(() =>
                {
                    PostAuthStateToUi(st);
                    AppendChat("system", st.can_chat ? "Token refreshed." : (st.message ?? "Refresh completed."), null);
                });
            }
            catch (Exception ex)
            {
                Ui(() =>
                {
                    PostToUi("auth.error", new { error = ex.Message });
                    PostAuthStateToUi();
                });
            }
        }

        private void HandleAuthSignOut()
        {
            try
            {
                var st = _authSession.SignOut();
                Ui(() =>
                {
                    PostAuthStateToUi(st);
                    AppendChat("system", "Signed out.", null);
                });
            }
            catch (Exception ex)
            {
                Ui(() => PostToUi("auth.error", new { error = ex.Message }));
            }
        }

        private async Task<bool> EnsureAuthReadyForChatAsync()
        {
            var canChat = await _authSession.EnsureCanChatAsync(CancellationToken.None).ConfigureAwait(false);
            Ui(() => PostAuthStateToUi());

            if (canChat) return true;

            Ui(() =>
            {
                var st = _authSession.GetState();
                var reason = string.IsNullOrWhiteSpace(st.message)
                    ? "Sign-in required before sending chat."
                    : st.message!;
                if (_webView?.CoreWebView2 != null) PostToUi("auth.required", new { message = reason });
                AppendChat("system", reason, null);
            });
            return false;
        }

        private void PostAuthStateToUi()
        {
            if (_webView?.CoreWebView2 == null) return;
            PostAuthStateToUi(_authSession.GetState());
        }

        private void PostAuthStateToUi(OperatorAuthUiState st)
        {
            if (_webView?.CoreWebView2 == null) return;
            PostToUi("auth.state", st);
        }

        private sealed class ScreenshareContextResult
        {
            public object? Context { get; set; }
            public string Signature { get; set; } = "";
        }

        private sealed class ScreenshareCaptureResult
        {
            public System.Collections.Generic.List<SavedUpload> Saved { get; set; } = new System.Collections.Generic.List<SavedUpload>();
            public string Signature { get; set; } = "";
        }

        private static string BuildScreenshareSignature(
            string? documentPath,
            long viewId,
            string? sheetNumber,
            System.Collections.Generic.List<long> selectionIds,
            Autodesk.Revit.DB.XYZ? zoomMin,
            Autodesk.Revit.DB.XYZ? zoomMax)
        {
            static double Q(double v) => Math.Round(v, 2);

            var doc = (documentPath ?? "").Trim();
            var sheet = (sheetNumber ?? "").Trim();

            // FNV-1a 64-bit over selection ids (sorted).
            ulong selHash = 1469598103934665603UL;
            if (selectionIds != null && selectionIds.Count > 0)
            {
                foreach (var id in selectionIds.OrderBy(x => x))
                {
                    unchecked
                    {
                        selHash ^= (ulong)id;
                        selHash *= 1099511628211UL;
                    }
                }
            }

            var zoom = zoomMin != null && zoomMax != null
                ? $"zoom:{Q(zoomMin.X)},{Q(zoomMin.Y)},{Q(zoomMin.Z)}..{Q(zoomMax.X)},{Q(zoomMax.Y)},{Q(zoomMax.Z)}"
                : "zoom:none";

            return $"{doc}|view:{viewId}|sheet:{sheet}|sel:{(selectionIds?.Count ?? 0)}:{selHash:x}|{zoom}";
        }

        private static object? TryBuildRevitWindowCursorPacket(RECT r, POINT p)
        {
            try
            {
                var w = Math.Max(1, r.Right - r.Left);
                var h = Math.Max(1, r.Bottom - r.Top);
                var wx = p.X - r.Left;
                var wy = p.Y - r.Top;
                var inWindow = wx >= 0 && wy >= 0 && wx <= w && wy <= h;

                double nx = 0;
                double ny = 0;
                if (inWindow)
                {
                    nx = (double)wx / (double)w;
                    ny = (double)wy / (double)h;
                }

                return new
                {
                    cursor = new
                    {
                        screenX = p.X,
                        screenY = p.Y,
                        windowX = wx,
                        windowY = wy,
                        normalizedX = Math.Round(nx, 6),
                        normalizedY = Math.Round(ny, 6),
                        in_window = inWindow,
                        basis = "revit_window_pixels (same coordinate basis as the screenshare jpg)"
                    },
                    revit_window = new
                    {
                        left = r.Left,
                        top = r.Top,
                        width = w,
                        height = h,
                        basis = "screen pixels (GetWindowRect)"
                    }
                };
            }
            catch
            {
                return null;
            }
        }

        private static object? TryGetRevitWindowCursorPacket()
        {
            try
            {
                var hwnd = Process.GetCurrentProcess().MainWindowHandle;
                if (hwnd == IntPtr.Zero) return null;
                if (!GetWindowRect(hwnd, out var r)) return null;
                if (!GetCursorPos(out var p)) return null;
                return TryBuildRevitWindowCursorPacket(r, p);
            }
            catch
            {
                return null;
            }
        }

        private async Task<ScreenshareContextResult> CaptureScreenshareContextAsync()
        {
            try
            {
                return await _eventService.Run(app =>
                {
                    var uidoc = app.ActiveUIDocument;
                    var doc = uidoc?.Document;
                    var view = uidoc?.ActiveView;
                    var sel = new List<long>();
                    try
                    {
                        foreach (var id in uidoc?.Selection?.GetElementIds() ?? new HashSet<Autodesk.Revit.DB.ElementId>())
                            sel.Add(RevitBridge.Common.ElementIdCompat.GetValue(id));
                    }
                    catch { }

                    Autodesk.Revit.DB.XYZ? zoomMin = null;
                    Autodesk.Revit.DB.XYZ? zoomMax = null;
                    object? zoom = null;
                    try
                    {
                        if (uidoc != null && view != null)
                        {
                            var uivs = uidoc.GetOpenUIViews();
                            var uiv = uivs?.FirstOrDefault(x => x != null && x.ViewId != null && RevitBridge.Common.ElementIdCompat.GetValue(x.ViewId) == RevitBridge.Common.ElementIdCompat.GetValue(view.Id));
                            if (uiv != null)
                            {
                                // Revit API: GetZoomCorners returns two XYZ points in model coordinates.
                                var corners = uiv.GetZoomCorners();
                                if (corners != null && corners.Count >= 2)
                                {
                                    var a = corners[0];
                                    var b = corners[1];
                                    zoomMin = new Autodesk.Revit.DB.XYZ(Math.Min(a.X, b.X), Math.Min(a.Y, b.Y), Math.Min(a.Z, b.Z));
                                    zoomMax = new Autodesk.Revit.DB.XYZ(Math.Max(a.X, b.X), Math.Max(a.Y, b.Y), Math.Max(a.Z, b.Z));
                                    zoom = new
                                    {
                                        minX = zoomMin.X,
                                        minY = zoomMin.Y,
                                        minZ = zoomMin.Z,
                                        maxX = zoomMax.X,
                                        maxY = zoomMax.Y,
                                        maxZ = zoomMax.Z,
                                        note = "feet, model coords (UIView.GetZoomCorners)"
                                    };
                                }
                            }
                        }
                    }
                    catch { zoom = null; zoomMin = null; zoomMax = null; }

                    string? sheetNumber = null;
                    string? sheetName = null;
                    try
                    {
                        if (view is Autodesk.Revit.DB.ViewSheet vs)
                        {
                            sheetNumber = vs.SheetNumber;
                            sheetName = vs.Name;
                        }
                    }
                    catch { }

                    object? cursorPacket = null;
                    try
                    {
                        var hwnd = Process.GetCurrentProcess().MainWindowHandle;
                        if (hwnd != IntPtr.Zero && GetWindowRect(hwnd, out var rr) && GetCursorPos(out var pp))
                            cursorPacket = TryBuildRevitWindowCursorPacket(rr, pp);
                    }
                    catch { cursorPacket = null; }

                    var contextObj = (object)new
                    {
                        captured_at = DateTime.UtcNow.ToString("o"),
                        revit = new
                        {
                            document_title = doc?.Title,
                            document_path = doc?.PathName,
                            active_view = new
                            {
                                id = RevitBridge.Common.ElementIdCompat.GetValue(view?.Id),
                                name = view?.Name,
                                view_type = view?.ViewType.ToString(),
                                scale = SafeViewScale(view),
                                sheet_number = sheetNumber,
                                sheet_name = sheetName
                            },
                            selection_ids = sel.OrderBy(x => x).ToArray(),
                            zoom_corners = zoom,
                            cursor = cursorPacket
                        },
                        note = "This context accompanies a screenshare screenshot to help the agent understand what you're looking at."
                    };

                    var sig = BuildScreenshareSignature(
                        documentPath: doc?.PathName,
                        viewId: RevitBridge.Common.ElementIdCompat.GetValue(view?.Id),
                        sheetNumber: sheetNumber,
                        selectionIds: sel,
                        zoomMin: zoomMin,
                        zoomMax: zoomMax);

                    return new ScreenshareContextResult { Context = contextObj, Signature = sig };
                }).ConfigureAwait(false);
            }
            catch (Exception ex)
            {
                return new ScreenshareContextResult
                {
                    Context = new { captured_at = DateTime.UtcNow.ToString("o"), warning = "Failed to capture Revit context: " + ex.Message },
                    Signature = "context_error:" + ex.GetType().Name
                };
            }
        }

        private async Task<ScreenshareCaptureResult> CaptureScreenshareAsync(ScreenshareContextResult? preContext = null)
        {
            // Returns the files that were saved under Workspace artifacts/uploads.
            // Does not modify the pending-attachments strip or append chat messages (callers decide).

            var ctxResult = preContext ?? await CaptureScreenshareContextAsync().ConfigureAwait(false);
            var ctx = ctxResult.Context;

            // Capture the Revit main window rectangle.
            var h = Process.GetCurrentProcess().MainWindowHandle;
            if (h == IntPtr.Zero) throw new Exception("Revit main window handle not found.");
            if (!GetWindowRect(h, out var r)) throw new Exception("GetWindowRect failed.");

            var w = Math.Max(1, r.Right - r.Left);
            var hgt = Math.Max(1, r.Bottom - r.Top);

            using var bmp = new Bitmap(w, hgt, System.Drawing.Imaging.PixelFormat.Format24bppRgb);
            using (var g = Graphics.FromImage(bmp))
            {
                g.CopyFromScreen(r.Left, r.Top, 0, 0, new System.Drawing.Size(w, hgt), CopyPixelOperation.SourceCopy);
            }

            // Resize if huge (keeps payload under the backend 5MB image cap more often).
            using var final = DownscaleIfNeeded(bmp, maxSidePx: 2200);

            // Draw a visible cursor marker if the cursor is inside the Revit window. This helps "pointing" work.
            try
            {
                if (GetCursorPos(out var p))
                {
                    var wx = p.X - r.Left;
                    var wy = p.Y - r.Top;
                    var inWindow = wx >= 0 && wy >= 0 && wx <= w && wy <= hgt;
                    if (inWindow)
                    {
                        var sx = (int)Math.Round((double)wx * (double)final.Width / (double)w);
                        var sy = (int)Math.Round((double)wy * (double)final.Height / (double)hgt);
                        sx = Math.Max(0, Math.Min(final.Width - 1, sx));
                        sy = Math.Max(0, Math.Min(final.Height - 1, sy));

                        using var g2 = Graphics.FromImage(final);
                        g2.SmoothingMode = System.Drawing.Drawing2D.SmoothingMode.AntiAlias;

                        const int radius = 14;
                        const int arm = 26;
                        using var penShadow = new System.Drawing.Pen(System.Drawing.Color.FromArgb(200, 0, 0, 0), 5f);
                        using var pen = new System.Drawing.Pen(System.Drawing.Color.FromArgb(235, 255, 40, 40), 3f);

                        g2.DrawEllipse(penShadow, sx - radius, sy - radius, radius * 2, radius * 2);
                        g2.DrawLine(penShadow, sx - arm, sy, sx + arm, sy);
                        g2.DrawLine(penShadow, sx, sy - arm, sx, sy + arm);

                        g2.DrawEllipse(pen, sx - radius, sy - radius, radius * 2, radius * 2);
                        g2.DrawLine(pen, sx - arm, sy, sx + arm, sy);
                        g2.DrawLine(pen, sx, sy - arm, sx, sy + arm);
                    }
                }
            }
            catch
            {
                // ignore cursor overlay failures
            }

            var stamp = DateTime.Now.ToString("yyyyMMdd_HHmmss_fff");
            var uploadsDir = WorkspacePaths.EnsureDir("artifacts", "uploads");
            var baseName = $"screenshare_{stamp}";

            var imgName = baseName + ".jpg";
            var ctxName = baseName + "_context.json";

            var imgFull = Path.Combine(uploadsDir, imgName);
            var ctxFull = Path.Combine(uploadsDir, ctxName);

            SaveJpeg(imgFull, final, quality: 80L);
            File.WriteAllText(ctxFull, JsonSerializer.Serialize(ctx, OperatorUiProtocol.JsonOptions) + "\n", Encoding.UTF8);

            var imgInfo = new FileInfo(imgFull);
            var ctxInfo = new FileInfo(ctxFull);

            var imgId = Guid.NewGuid().ToString("N");
            var ctxId = Guid.NewGuid().ToString("N");

            string? imgSha = null;
            string? ctxSha = null;
            try { imgSha = ComputeSha256Hex(imgFull); } catch { }
            try { ctxSha = ComputeSha256Hex(ctxFull); } catch { }

            var createdAt = DateTime.UtcNow.ToString("o");

            var saved = new List<SavedUpload>
            {
                new SavedUpload
                {
                    Id = imgId,
                    OriginalPath = "",
                    FullPath = imgFull,
                    RelativePath = ("artifacts/uploads/" + imgName).Replace("\\", "/"),
                    Bytes = imgInfo.Length,
                    FileName = imgName,
                    Sha256 = imgSha,
                    Mime = "image/jpeg",
                    CreatedAt = createdAt
                },
                new SavedUpload
                {
                    Id = ctxId,
                    OriginalPath = "",
                    FullPath = ctxFull,
                    RelativePath = ("artifacts/uploads/" + ctxName).Replace("\\", "/"),
                    Bytes = ctxInfo.Length,
                    FileName = ctxName,
                    Sha256 = ctxSha,
                    Mime = "application/json",
                    CreatedAt = createdAt
                }
            };

            TryAppendUploadIndexJsonl(new
            {
                id = imgId,
                relative_path = ("artifacts/uploads/" + imgName).Replace("\\", "/"),
                filename = imgName,
                bytes = imgInfo.Length,
                sha256 = imgSha,
                mime = "image/jpeg",
                created_at = createdAt,
                kind = "screenshare",
                context_relative_path = ("artifacts/uploads/" + ctxName).Replace("\\", "/")
            });

            TryAppendUploadIndexJsonl(new
            {
                id = ctxId,
                relative_path = ("artifacts/uploads/" + ctxName).Replace("\\", "/"),
                filename = ctxName,
                bytes = ctxInfo.Length,
                sha256 = ctxSha,
                mime = "application/json",
                created_at = createdAt,
                kind = "screenshare_context",
                related_image_relative_path = ("artifacts/uploads/" + imgName).Replace("\\", "/")
            });

            return new ScreenshareCaptureResult { Saved = saved, Signature = ctxResult.Signature };
        }

        private static bool IsScreenshareUploadFileName(string? fileName)
        {
            var n = (fileName ?? "").Trim();
            if (string.IsNullOrWhiteSpace(n)) return false;
            if (n.StartsWith("screenshare_", StringComparison.OrdinalIgnoreCase)) return true;
            if (n.StartsWith("clipboard_", StringComparison.OrdinalIgnoreCase)) return true;
            return false;
        }

        private void TrackScreenshareFilesForActiveChat(IEnumerable<SavedUpload>? saved)
        {
            if (saved == null) return;
            foreach (var s in saved)
            {
                if (s == null) continue;
                if (!IsScreenshareUploadFileName(s.FileName)) continue;
                if (string.IsNullOrWhiteSpace(s.FullPath)) continue;
                _activeChatScreenshareFiles.Add(s.FullPath);
            }
        }

        private static bool TryDeleteFileNoThrow(string? fullPath)
        {
            try
            {
                if (string.IsNullOrWhiteSpace(fullPath)) return false;
                if (!File.Exists(fullPath)) return false;
                File.Delete(fullPath);
                return true;
            }
            catch
            {
                return false;
            }
        }

        private void CleanupActiveChatScreenshareFiles()
        {
            if (_activeChatScreenshareFiles.Count == 0) return;
            foreach (var p in _activeChatScreenshareFiles.ToArray())
            {
                TryDeleteFileNoThrow(p);
            }
            _activeChatScreenshareFiles.Clear();
            TryCompactUploadsIndex();
        }

        private void TryCleanupScreenshareUploads(bool deleteAllScreenshares, TimeSpan? ttl)
        {
            try
            {
                var uploadsDir = WorkspacePaths.EnsureDir("artifacts", "uploads");
                if (!Directory.Exists(uploadsDir)) return;

                var nowUtc = DateTime.UtcNow;
                var cutoffUtc = ttl.HasValue ? nowUtc - ttl.Value : DateTime.MinValue;
                var deletedAny = false;

                foreach (var full in Directory.EnumerateFiles(uploadsDir))
                {
                    var name = Path.GetFileName(full);
                    if (!IsScreenshareUploadFileName(name)) continue;

                    var shouldDelete = deleteAllScreenshares;
                    if (!shouldDelete && ttl.HasValue)
                    {
                        DateTime fileUtc;
                        try { fileUtc = File.GetLastWriteTimeUtc(full); }
                        catch { fileUtc = DateTime.MinValue; }
                        shouldDelete = fileUtc <= cutoffUtc;
                    }

                    if (!shouldDelete) continue;
                    if (TryDeleteFileNoThrow(full)) deletedAny = true;
                }

                if (deletedAny) TryCompactUploadsIndex();
            }
            catch
            {
                // best effort
            }
        }

        private static void TryCompactUploadsIndex()
        {
            try
            {
                var indexFull = WorkspacePaths.ResolveFileUnderWorkspace(Path.Combine("artifacts", "uploads", "_uploads.jsonl"));
                if (!File.Exists(indexFull)) return;

                var kept = new List<string>();
                foreach (var raw in File.ReadLines(indexFull, Encoding.UTF8))
                {
                    var line = (raw ?? "").Trim();
                    if (line.Length == 0) continue;

                    try
                    {
                        using var doc = JsonDocument.Parse(line);
                        if (doc.RootElement.ValueKind != JsonValueKind.Object)
                        {
                            kept.Add(line);
                            continue;
                        }

                        if (!doc.RootElement.TryGetProperty("relative_path", out var rp) || rp.ValueKind != JsonValueKind.String)
                        {
                            kept.Add(line);
                            continue;
                        }

                        var rel = (rp.GetString() ?? "").Trim();
                        if (string.IsNullOrWhiteSpace(rel))
                        {
                            kept.Add(line);
                            continue;
                        }

                        string full;
                        try { full = WorkspacePaths.ResolveFileUnderWorkspace(rel); }
                        catch
                        {
                            continue;
                        }

                        if (File.Exists(full)) kept.Add(line);
                    }
                    catch
                    {
                        // Preserve malformed lines as-is.
                        kept.Add(line);
                    }
                }

                var tmp = indexFull + ".tmp";
                File.WriteAllText(tmp, kept.Count == 0 ? "" : (string.Join("\n", kept) + "\n"), new UTF8Encoding(false));
                File.Copy(tmp, indexFull, overwrite: true);
                TryDeleteFileNoThrow(tmp);
            }
            catch
            {
                // ignore
            }
        }

        private static System.Collections.Generic.List<OperatorUserAttachment> ToUserAttachments(System.Collections.Generic.List<SavedUpload> saved)
        {
            var outList = new System.Collections.Generic.List<OperatorUserAttachment>();
            if (saved == null || saved.Count == 0) return outList;
            foreach (var s in saved)
            {
                if (s == null) continue;
                outList.Add(new OperatorUserAttachment
                {
                    Id = s.Id,
                    RelativePath = s.RelativePath,
                    Filename = s.FileName,
                    Bytes = s.Bytes,
                    Sha256 = s.Sha256,
                    Mime = s.Mime,
                    CreatedAt = s.CreatedAt
                });
            }
            return outList;
        }

        private static bool GetEnvBool(string name, bool @default)
        {
            var v = Environment.GetEnvironmentVariable(name);
            if (string.IsNullOrWhiteSpace(v)) return @default;
            v = v.Trim();
            if (string.Equals(v, "1", StringComparison.OrdinalIgnoreCase) ||
                string.Equals(v, "true", StringComparison.OrdinalIgnoreCase) ||
                string.Equals(v, "yes", StringComparison.OrdinalIgnoreCase) ||
                string.Equals(v, "on", StringComparison.OrdinalIgnoreCase))
                return true;
            if (string.Equals(v, "0", StringComparison.OrdinalIgnoreCase) ||
                string.Equals(v, "false", StringComparison.OrdinalIgnoreCase) ||
                string.Equals(v, "no", StringComparison.OrdinalIgnoreCase) ||
                string.Equals(v, "off", StringComparison.OrdinalIgnoreCase))
                return false;
            return @default;
        }

        private static int? SafeViewScale(Autodesk.Revit.DB.View? view)
        {
            try { return view?.Scale; } catch { return null; }
        }

        private static Bitmap DownscaleIfNeeded(Bitmap src, int maxSidePx)
        {
            if (src == null) throw new ArgumentNullException(nameof(src));
            if (maxSidePx <= 0) return (Bitmap)src.Clone();

            var w = src.Width;
            var h = src.Height;
            var max = Math.Max(w, h);
            if (max <= maxSidePx) return (Bitmap)src.Clone();

            var scale = (double)maxSidePx / (double)max;
            var nw = Math.Max(1, (int)Math.Round(w * scale));
            var nh = Math.Max(1, (int)Math.Round(h * scale));

            var dst = new Bitmap(nw, nh, System.Drawing.Imaging.PixelFormat.Format24bppRgb);
            using (var g = Graphics.FromImage(dst))
            {
                g.InterpolationMode = System.Drawing.Drawing2D.InterpolationMode.HighQualityBicubic;
                g.SmoothingMode = System.Drawing.Drawing2D.SmoothingMode.HighQuality;
                g.PixelOffsetMode = System.Drawing.Drawing2D.PixelOffsetMode.HighQuality;
                g.DrawImage(src, 0, 0, nw, nh);
            }
            return dst;
        }

        private static void SaveJpeg(string fullPath, Bitmap bmp, long quality)
        {
            if (bmp == null) throw new ArgumentNullException(nameof(bmp));
            Directory.CreateDirectory(Path.GetDirectoryName(fullPath) ?? WorkspacePaths.EnsureDir("artifacts", "uploads"));

            var codec = ImageCodecInfo.GetImageEncoders().FirstOrDefault(c => c != null && c.MimeType == "image/jpeg");
            if (codec == null)
            {
                bmp.Save(fullPath, ImageFormat.Jpeg);
                return;
            }

            using var p = new EncoderParameters(1);
            p.Param[0] = new EncoderParameter(System.Drawing.Imaging.Encoder.Quality, Math.Max(10L, Math.Min(100L, quality)));
            bmp.Save(fullPath, codec, p);
        }
        private async Task HandleFilePickAsync()
        {
            try
            {
                string[] files = Array.Empty<string>();
                Ui(() =>
                {
                    var dlg = new OpenFileDialog
                    {
                        Title = "Attach file(s) to Operator (copied into Workspace artifacts)",
                        Multiselect = true,
                        Filter =
                            "Supported files|*.pdf;*.docx;*.xlsx;*.xls;*.txt;*.csv;*.jpg;*.jpeg;*.png|" +
                            "PDF (*.pdf)|*.pdf|" +
                            "Word (*.docx)|*.docx|" +
                            "Excel (*.xlsx;*.xls)|*.xlsx;*.xls|" +
                            "Text (*.txt;*.csv)|*.txt;*.csv|" +
                            "Images (*.jpg;*.jpeg;*.png)|*.jpg;*.jpeg;*.png|" +
                            "All files|*.*"
                    };

                    var ok = dlg.ShowDialog();
                    if (ok == true && dlg.FileNames != null && dlg.FileNames.Length > 0)
                        files = dlg.FileNames;
                });

                if (files == null || files.Length == 0) return;
                await HandleIncomingFilesAsync(files, source: "picker").ConfigureAwait(false);
            }
            catch (Exception ex)
            {
                Ui(() => AppendChat("system", "Attach failed: " + ex.Message, null));
            }
        }

        private async Task HandleIncomingFilesAsync(string[] files, string source)
        {
            // Copy in background to avoid blocking Revit UI on large files.
            var saved = await Task.Run(() => SaveUploadsToWorkspace(files)).ConfigureAwait(false);
            if (saved.Count == 0)
            {
                Ui(() =>
                    AppendChat(
                        "system",
                        "No supported files were attached. Supported: .pdf, .docx, .xlsx/.xls, .txt/.csv, .jpg/.jpeg/.png.\n" +
                            "[Open uploads folder](op://open-folder?path=artifacts/uploads)",
                        null));
                return;
            }

            var sb = new StringBuilder();
            sb.AppendLine($"Attached {saved.Count} file(s) ({source}). Saved under Workspace:");
            foreach (var s in saved)
            {
                sb.AppendLine($"- {s.RelativePath}");
            }
            sb.AppendLine();
            sb.AppendLine("[Open uploads folder](op://open-folder?path=artifacts/uploads)");

            Ui(() => AppendChat("system", sb.ToString().Trim(), null));
            Ui(() => _fallback?.AddAttachments(ToUserAttachments(saved)));

            // Populate the attachments strip (first-class inputs). These remain "pending" until the user hits Send.
            try
            {
                var payload = new
                {
                    attachments = saved.Select(s => new
                    {
                        id = s.Id,
                        relative_path = s.RelativePath,
                        filename = s.FileName,
                        bytes = s.Bytes,
                        sha256 = s.Sha256,
                        mime = s.Mime,
                        created_at = s.CreatedAt
                    }).ToArray()
                };
                Ui(() => { if (_webView?.CoreWebView2 != null) PostToUi("attachments.added", payload); });
            }
            catch
            {
                // ignore
            }

            // Convenience: prefill command for spec import when a single .docx/.txt is attached.
            if (saved.Count == 1)
            {
                var one = saved[0];
                var ext = (Path.GetExtension(one.RelativePath) ?? "").ToLowerInvariant();
                if (ext == ".docx" || ext == ".txt")
                {
                    var cmd =
                        "run skill import_drawing_spec with " +
                        "{\"sourcePath\":\"" + one.RelativePath.Replace("\\", "/") + "\",\"viewName\":\"Specs\",\"columns\":4}";
                    Ui(() => { if (_webView?.CoreWebView2 != null) PostToUi("input.set", new { text = cmd }); });
                }
            }
        }

        private sealed class SavedUpload
        {
            public string Id { get; set; } = "";
            public string RelativePath { get; set; } = "";
            public string FullPath { get; set; } = "";
            public long Bytes { get; set; }
            public string OriginalPath { get; set; } = "";
            public string FileName { get; set; } = "";
            public string? Sha256 { get; set; }
            public string? Mime { get; set; }
            public string? CreatedAt { get; set; }
        }

        private static SavedUpload? SaveClipboardImageToWorkspace(byte[] bytes, string? mime)
        {
            if (bytes == null || bytes.Length <= 0) return null;

            var uploadsDir = WorkspacePaths.EnsureDir("artifacts", "uploads");
            var stamp = DateTime.Now.ToString("yyyyMMdd_HHmmss_fff");
            var m = (mime ?? "").Trim().ToLowerInvariant();
            var ext = m.Contains("png") ? ".png" : ".jpg";
            var logicalName = "clipboard_" + stamp + ext;
            var destName = logicalName;
            var destFull = Path.Combine(uploadsDir, destName);
            var n = 2;
            while (File.Exists(destFull) && n <= 50)
            {
                destName = $"clipboard_{stamp} ({n}){ext}";
                destFull = Path.Combine(uploadsDir, destName);
                n++;
            }

            File.WriteAllBytes(destFull, bytes);
            var fi = new FileInfo(destFull);
            var id = Guid.NewGuid().ToString("N");
            string? sha = null;
            try { sha = ComputeSha256Hex(destFull); } catch { }
            var resolvedMime = ext == ".png" ? "image/png" : "image/jpeg";
            var createdAt = DateTime.UtcNow.ToString("o");

            var saved = new SavedUpload
            {
                Id = id,
                OriginalPath = "",
                FullPath = destFull,
                RelativePath = ("artifacts/uploads/" + destName).Replace("\\", "/"),
                Bytes = fi.Length,
                FileName = logicalName,
                Sha256 = sha,
                Mime = resolvedMime,
                CreatedAt = createdAt
            };

            TryAppendUploadIndexJsonl(new
            {
                id,
                relative_path = saved.RelativePath,
                filename = logicalName,
                bytes = fi.Length,
                sha256 = sha,
                mime = resolvedMime,
                created_at = createdAt,
                kind = "clipboard_image"
            });

            return saved;
        }

        private static List<SavedUpload> SaveUploadsToWorkspace(string[] files)
        {
            var outList = new List<SavedUpload>();
            if (files == null || files.Length == 0) return outList;

            var allowed = new HashSet<string>(StringComparer.OrdinalIgnoreCase)
            {
                ".pdf",
                ".docx",
                ".xlsx",
                ".xls",
                ".txt",
                ".csv",
                ".jpg",
                ".jpeg",
                ".png"
            };

            var uploadsDir = WorkspacePaths.EnsureDir("artifacts", "uploads");
            var stamp = DateTime.Now.ToString("yyyyMMdd_HHmmss");

            foreach (var f in files)
            {
                try
                {
                    var src = (f ?? "").Trim();
                    if (string.IsNullOrWhiteSpace(src) || !File.Exists(src)) continue;

                    var ext = (Path.GetExtension(src) ?? "").Trim();
                    if (string.IsNullOrWhiteSpace(ext) || !allowed.Contains(ext)) continue;

                    var fi = new FileInfo(src);
                    // Safety cap: avoid accidental multi-GB copies.
                    if (fi.Length > 250L * 1024L * 1024L) continue; // 250MB

                    var safeName = SanitizeFileName(Path.GetFileName(src));
                    var destName = $"{stamp}_{safeName}";
                    if (destName.Length > 180)
                    {
                        var e = ext;
                        var baseName = Path.GetFileNameWithoutExtension(destName);
                        if (baseName.Length > 160) baseName = baseName.Substring(0, 160).Trim();
                        destName = baseName + e;
                    }

                    var destFull = Path.Combine(uploadsDir, destName);
                    var tryN = 2;
                    while (File.Exists(destFull) && tryN <= 50)
                    {
                        var baseName = Path.GetFileNameWithoutExtension(destName);
                        destName = $"{baseName} ({tryN}){ext}";
                        destFull = Path.Combine(uploadsDir, destName);
                        tryN++;
                    }

                    File.Copy(src, destFull, overwrite: false);

                    var id = Guid.NewGuid().ToString("N");
                    string? sha = null;
                    try { sha = ComputeSha256Hex(destFull); } catch { sha = null; }
                    var mime = GuessMimeFromExtension(ext);
                    var createdAt = DateTime.UtcNow.ToString("o");

                    outList.Add(new SavedUpload
                    {
                        Id = id,
                        OriginalPath = src,
                        FullPath = destFull,
                        RelativePath = ("artifacts/uploads/" + destName).Replace("\\", "/"),
                        Bytes = fi.Length,
                        FileName = safeName,
                        Sha256 = sha,
                        Mime = mime,
                        CreatedAt = createdAt
                    });

                    TryAppendUploadIndexJsonl(new
                    {
                        id,
                        relative_path = ("artifacts/uploads/" + destName).Replace("\\", "/"),
                        filename = safeName,
                        bytes = fi.Length,
                        sha256 = sha,
                        mime,
                        created_at = createdAt,
                        original_path = src
                    });
                }
                catch
                {
                    // best-effort per file
                }
            }

            return outList;
        }

        private static string? GuessMimeFromExtension(string ext)
        {
            var e = (ext ?? "").Trim().ToLowerInvariant();
            if (e == ".pdf") return "application/pdf";
            if (e == ".docx") return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
            if (e == ".xlsx") return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
            if (e == ".xls") return "application/vnd.ms-excel";
            if (e == ".txt") return "text/plain";
            if (e == ".csv") return "text/csv";
            if (e == ".jpg" || e == ".jpeg") return "image/jpeg";
            if (e == ".png") return "image/png";
            return null;
        }

        private static string ComputeSha256Hex(string filePath)
        {
            using (var sha = System.Security.Cryptography.SHA256.Create())
            using (var s = File.OpenRead(filePath))
            {
                var hash = sha.ComputeHash(s);
                var sb = new StringBuilder(hash.Length * 2);
                for (int i = 0; i < hash.Length; i++) sb.Append(hash[i].ToString("x2"));
                return sb.ToString();
            }
        }

        private static void TryAppendUploadIndexJsonl(object record)
        {
            try
            {
                var full = WorkspacePaths.ResolveFileUnderWorkspace(Path.Combine("artifacts", "uploads", "_uploads.jsonl"));
                var dir = Path.GetDirectoryName(full);
                if (!string.IsNullOrWhiteSpace(dir)) Directory.CreateDirectory(dir);
                var line = JsonSerializer.Serialize(record, OperatorUiProtocol.JsonOptions) + "\n";
                File.AppendAllText(full, line, Encoding.UTF8);
            }
            catch
            {
                // ignore
            }
        }

        private static string SanitizeFileName(string name)
        {
            var s = (name ?? "").Trim();
            if (s.Length == 0) return "file";
            foreach (var c in Path.GetInvalidFileNameChars()) s = s.Replace(c, '_');
            s = s.Replace(Path.DirectorySeparatorChar, '_').Replace(Path.AltDirectorySeparatorChar, '_');
            s = Path.GetFileName(s);
            if (s.Length == 0) s = "file";
            if (s.Length > 180) s = s.Substring(0, 180).Trim();
            return s;
        }

        private static bool LooksLikeFilePath(string p)
        {
            var s = (p ?? "").Trim();
            if (string.IsNullOrWhiteSpace(s)) return false;
            s = s.TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
            if (string.IsNullOrWhiteSpace(s)) return false;
            var name = Path.GetFileName(s);
            if (string.IsNullOrWhiteSpace(name)) return false;
            if (name.IndexOf('.') < 0) return false;
            var ext = Path.GetExtension(name);
            if (string.IsNullOrWhiteSpace(ext)) return false;
            if (ext.Length > 12) return false;
            return true;
        }

        private static void OpenWorkspacePathInExplorer(string? userPath)
        {
            var p = (userPath ?? "").Trim();
            if (string.IsNullOrWhiteSpace(p)) p = Path.Combine("artifacts", "prints");

            // Defensive decode for clients that pass encoded slashes.
            try
            {
                if (p.IndexOf('%') >= 0) p = Uri.UnescapeDataString(p);
            }
            catch { }

            string args;
            var full = WorkspacePaths.ResolveFileUnderWorkspace(p);

            // Never create directories as a side effect of opening Explorer. (It confused users by creating
            // folders named like "something.png" when a file path was misclassified.)
            string EnsureDefaultPrintsDir()
            {
                try { return WorkspacePaths.EnsureDir("artifacts", "prints"); }
                catch { return WorkspacePaths.GetWorkspaceRoot(); }
            }

            string NearestExistingDir(string? start)
            {
                try
                {
                    var root = Path.GetFullPath(WorkspacePaths.GetWorkspaceRoot())
                        .TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
                    var cur = string.IsNullOrWhiteSpace(start) ? "" : Path.GetFullPath(start);
                    while (!string.IsNullOrWhiteSpace(cur))
                    {
                        var c = cur.TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
                        if (string.Equals(c, root, StringComparison.OrdinalIgnoreCase)) break;
                        if (Directory.Exists(c)) return c;
                        cur = Path.GetDirectoryName(c);
                    }
                }
                catch { }
                return EnsureDefaultPrintsDir();
            }

            if (LooksLikeFilePath(p))
            {
                if (File.Exists(full))
                {
                    args = "/select,\"" + full + "\"";
                }
                else
                {
                    args = "\"" + NearestExistingDir(Path.GetDirectoryName(full)) + "\"";
                }
            }
            else
            {
                if (Directory.Exists(full))
                {
                    args = "\"" + full + "\"";
                }
                else if (File.Exists(full))
                {
                    args = "/select,\"" + full + "\"";
                }
                else
                {
                    args = "\"" + NearestExistingDir(Path.GetDirectoryName(full)) + "\"";
                }
            }

            var psi = new ProcessStartInfo
            {
                FileName = "explorer.exe",
                Arguments = args,
                UseShellExecute = true
            };
            Process.Start(psi);
        }

        private static void OpenAllowedOutputPath(string? userPath)
        {
            var p = (userPath ?? "").Trim();
            if (string.IsNullOrWhiteSpace(p)) throw new InvalidOperationException("path is required.");

            try
            {
                if (p.StartsWith("file://", StringComparison.OrdinalIgnoreCase))
                {
                    p = new Uri(p).LocalPath;
                }
                else if (p.IndexOf('%') >= 0)
                {
                    p = Uri.UnescapeDataString(p);
                }
            }
            catch { }

            var full = Path.GetFullPath(p);
            if (!IsAllowedOutputPath(full))
            {
                throw new UnauthorizedAccessException("path is outside allowed Operator output folders.");
            }
            if (!File.Exists(full) && !Directory.Exists(full))
            {
                throw new FileNotFoundException("path not found.", full);
            }

            if (Directory.Exists(full))
            {
                Process.Start(new ProcessStartInfo
                {
                    FileName = "explorer.exe",
                    Arguments = "\"" + full + "\"",
                    UseShellExecute = true
                });
                return;
            }

            Process.Start(new ProcessStartInfo
            {
                FileName = full,
                UseShellExecute = true
            });
        }

        private static bool IsAllowedOutputPath(string fullPath)
        {
            var roots = new[]
            {
                WorkspacePaths.GetWorkspaceRoot(),
                Environment.GetFolderPath(Environment.SpecialFolder.MyDocuments),
                Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory),
                Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), "Downloads")
            };
            return roots
                .Where(r => !string.IsNullOrWhiteSpace(r))
                .Any(r => IsSameOrUnder(fullPath, r));
        }

        private static bool IsSameOrUnder(string candidate, string root)
        {
            var normalizedRoot = Path.GetFullPath(root).TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
            var normalizedCandidate = Path.GetFullPath(candidate).TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
            return string.Equals(normalizedCandidate, normalizedRoot, StringComparison.OrdinalIgnoreCase) ||
                   normalizedCandidate.StartsWith(normalizedRoot + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase);
        }

        private async Task HandleVoiceTranscribeAsync(string requestId, string audioBase64, string format)
        {
            try
            {
                await EnsureBackendRunningAsync(CancellationToken.None).ConfigureAwait(false);
                var text = await _backendClient.VoiceTranscribeAsync(audioBase64, format, CancellationToken.None).ConfigureAwait(false);
                Ui(() => PostToUi("voice.result", new { requestId, text }));
            }
            catch (Exception ex)
            {
                Ui(() => PostToUi("voice.result", new { requestId, error = ex.Message }));
            }
        }

        private async Task HandleVoiceSpeakAsync(string requestId, string text, string format, string? voice)
        {
            try
            {
                await EnsureBackendRunningAsync(CancellationToken.None).ConfigureAwait(false);
                var r = await _backendClient.VoiceSpeakAsync(text, format, voice, CancellationToken.None).ConfigureAwait(false);

                if (r == null)
                {
                    Ui(() => PostToUi("voice.speak.result", new { requestId, error = "No TTS response." }));
                    return;
                }

                if (!string.IsNullOrWhiteSpace(r.Error))
                {
                    Ui(() => PostToUi("voice.speak.result", new { requestId, error = r.Error }));
                    return;
                }

                Ui(() => PostToUi("voice.speak.result", new
                {
                    requestId,
                    audioBase64 = r.AudioBase64 ?? "",
                    format = r.Format ?? format,
                    model = r.Model,
                    voice = r.Voice
                }));
            }
            catch (Exception ex)
            {
                Ui(() => PostToUi("voice.speak.result", new { requestId, error = ex.Message }));
            }
        }

        private void OnChatSend(string messageId, string text, System.Collections.Generic.List<OperatorUserAttachment>? attachments, bool shareWithAgent, bool autoOpenLatestAttachment, string reasoningEffort)
        {
            // Interject support: if a tool loop is actively running, cancel the in-flight step and resume this same turn.
            if (_activeTurn != null && _turnBusy)
            {
                lock (_interjectGate)
                {
                    _pendingInterjectTurn = _activeTurn;
                    _pendingInterjectMessageId = messageId;
                    _pendingInterjectText = text;
                }

                Ui(() => AppendChat("user", text, messageId));
                _ = LogInterjectAsync(messageId, text);

                try { _activeTurnCts?.Cancel(); } catch { }
                Ui(() => AppendChat("system", "Interrupt requested; continuing with your message…", null));
                return;
            }

            _ = HandleChatSendAsync(messageId, text, attachments, shareWithAgent, autoOpenLatestAttachment, reasoningEffort);
        }

        private async Task ResetChatAsync()
        {
            await _chatLock.WaitAsync().ConfigureAwait(false);
            try
            {
                try { _activeTurnCts?.Cancel(); } catch { }
                try { _activeTurnCts?.Dispose(); } catch { }
                _activeTurnCts = null;
                _turnBusy = false;

                // Clear any local pending state so we don't keep looping/approving stale actions.
                _activeTurn = null;
                _pendingApprovals.Clear();
                _turnByApprovalActionId.Clear();
                CleanupActiveChatScreenshareFiles();
                TryCleanupScreenshareUploads(deleteAllScreenshares: false, ttl: ScreenshareTtl);
                Ui(() => { if (_webView?.CoreWebView2 != null) PostToUi("loop.state", new { running = false }); });

                await EnsureBackendRunningAsync(CancellationToken.None).ConfigureAwait(false);

                // Force a new backend session (clears model-side conversation history).
                _sessionId = null;
                _proactivity?.OnSessionChanged(null);
                var sid = await EnsureSessionAsync().ConfigureAwait(false);

                try { _logger?.Dispose(); } catch { }
                _logger = new OperatorJsonlLogger(sid);
                await _logger.LogAsync("session.new", new { backend_session_id = sid }, CancellationToken.None).ConfigureAwait(false);

                Ui(() =>
                {
                    if (_webView?.CoreWebView2 != null) PostToUi("chat.reset", new { });
                    else _fallback?.ResetUi();
                });

                Ui(() =>
                {
                    AppendChat("system", $"New chat started. Backend: {_backendBaseUri}", null);
                    if (_webView?.CoreWebView2 != null)
                    {
                        PostToUi("policy.current", new { mode = UiModeString(_approvalMode) });
                          PostReasoningEffortToUi();
                          EnsureNativeApiPolicyForApprovalMode(postToUi: true, announceChat: false);
                        try
                        {
                            var status = EnsureWriteGrantForApprovalMode(forceIssue: false);
                            PostWriteGrantStatusToUi(status);
                        }
                        catch { }
                        PostAuthStateToUi();
                        PostToUi("tools.list", new { tools = OperatorToolManifest.Tools });
                    }
                });
            }
            catch (Exception ex)
            {
                Ui(() => AppendChat("assistant", $"Error: {FormatException(ex)}", null));
            }
            finally
            {
                _chatLock.Release();
            }
        }

        private async Task HandleChatSendAsync(string messageId, string text, System.Collections.Generic.List<OperatorUserAttachment>? attachments, bool shareWithAgent, bool autoOpenLatestAttachment, string reasoningEffort)
        {
            await _chatLock.WaitAsync().ConfigureAwait(false);
            try
            {
                var normalizedReasoningEffort = NormalizeReasoningEffort(reasoningEffort);
                _reasoningEffort = normalizedReasoningEffort;

                if (_activeTurn != null && _activeTurn.AwaitingApproval && _pendingApprovals.Count > 0)
                {
                    Ui(() => AppendChat("system", "There are pending approvals. Approve/reject them before sending a new message.", null));
                    return;
                }

                if (!await EnsureAuthReadyForChatAsync().ConfigureAwait(false))
                {
                    return;
                }

                var outgoingAttachments = shareWithAgent ? attachments : null;

                Ui(() => AppendChat("user", text, messageId));
                await EnsureBackendRunningAsync(CancellationToken.None).ConfigureAwait(false);

                var sid = await EnsureSessionAsync().ConfigureAwait(false);
                _logger ??= new OperatorJsonlLogger(sid);

                if (outgoingAttachments != null && outgoingAttachments.Count > 0)
                {
                    try
                    {
                        outgoingAttachments = await _backendClient
                            .UploadUserAttachmentsAsync(outgoingAttachments, sid, CancellationToken.None)
                            .ConfigureAwait(false);
                    }
                    catch (Exception ex)
                    {
                        Ui(() => AppendChat("system", "Attachment upload failed: " + ex.Message, null));
                        await _logger.LogAsync("attachment.upload.error", new
                        {
                            backend_session_id = sid,
                            message_id = messageId,
                            error = ex.Message
                        }, CancellationToken.None).ConfigureAwait(false);
                        return;
                    }
                }

                await _logger.LogAsync("chat.user", new
                {
                    backend_session_id = sid,
                    message_id = messageId,
                    text,
                    attachments = outgoingAttachments,
                    attachment_policy = new { share_with_agent = shareWithAgent, auto_open_latest_attachment = autoOpenLatestAttachment }
                }, CancellationToken.None).ConfigureAwait(false);
                object? baseContext = await TryGetPreChatRevitContextAsync(messageId).ConfigureAwait(false);

                // Lightweight "where is the cursor" hint so the agent can interpret pointing relative to the most recent screenshare.
                var cursorPacket = TryGetRevitWindowCursorPacket();

                OperatorWriteGrantStatus? writeGrantStatus = null;
                try
                {
                    writeGrantStatus = EnsureWriteGrantForApprovalMode(forceIssue: false);
                    Ui(() => PostWriteGrantStatusToUi(writeGrantStatus));
                }
                catch
                {
                    writeGrantStatus = null;
                }

                var context = new
                {
                    operator_brain_route = string.Equals(_brainRoute, "direct", StringComparison.Ordinal) ? "direct" : null,
                    revit = baseContext,
                    ui = new
                    {
                        cursor = cursorPacket,
                        reasoning_effort = normalizedReasoningEffort,
                        speed_settings = SpeedSettingsForContext(),
                        attachment_policy = new { share_with_agent = shareWithAgent, auto_open_latest_attachment = autoOpenLatestAttachment },
                        approval_mode = UiModeString(_approvalMode),
                        native_api_policy = OperatorNativeApiPolicy.GetStatus(),
                        write_grant = writeGrantStatus == null ? null : new
                        {
                            active = writeGrantStatus.Active,
                            mode = writeGrantStatus.Mode,
                            expires_at_utc = writeGrantStatus.ExpiresAtUtc?.ToString("o"),
                            uses_remaining = writeGrantStatus.UsesRemaining,
                            error = writeGrantStatus.Error
                        }
                    },
                    capabilities = OperatorCapabilities.Get(),
                    dev = new
                    {
                        enabled = IsDevModeEnabled(),
                        max_tool_steps = GetMaxToolLoopSteps()
                    },
                    budget = new
                    {
                        max_tool_steps = GetMaxToolLoopSteps(),
                        max_images = 3,
                        max_tool_time_ms = GetMaxToolTimeMs()
                    }
                };

                var turn = new OperatorTurnState
                {
                    SessionId = sid,
                    RootMessageId = messageId,
                    Context = context,
                    Step = 0,
                    UserAttachments = outgoingAttachments,
                    DryRunOnly = OperatorDryRunTurnPolicy.IsDryRunOnlyRequest(text)
                };
                _activeTurn = turn;

                Ui(() => { if (_webView?.CoreWebView2 != null) PostToUi("loop.state", new { running = true }); });

                try { _activeTurnCts?.Dispose(); } catch { }
                _activeTurnCts = new CancellationTokenSource();

                _turnBusy = true;
                try
                {
                    var loopUserText = text;
                    while (true)
                    {
                        try
                        {
                            await RunToolLoopAsync(turn, userText: loopUserText, _activeTurnCts.Token).ConfigureAwait(false);
                            break;
                        }
                        catch (OperationCanceledException) when (TryConsumeInterject(turn, out var interjectMessageId, out var interjectText))
                        {
                            Ui(() => AppendChat("system", "Interrupted. Continuing from current state…", null));
                            loopUserText = interjectText;

                            // Reset cancellation token for the resumed loop.
                            try { _activeTurnCts?.Dispose(); } catch { }
                            _activeTurnCts = new CancellationTokenSource();
                        }
                    }
                }
                finally
                {
                    _turnBusy = false;
                }
            }
            catch (OperationCanceledException ex)
            {
                var turnAtFailure = _activeTurn;
                var wasUserOrUiCancellation = _activeTurnCts != null && _activeTurnCts.IsCancellationRequested;

                _activeTurn = null;
                try { _activeTurnCts?.Dispose(); } catch { }
                _activeTurnCts = null;
                Ui(() => { if (_webView?.CoreWebView2 != null) PostToUi("loop.state", new { running = false }); });

                if (wasUserOrUiCancellation)
                {
                    Ui(() => AppendChat("system", "Cancelled.", null));
                }
                else
                {
                    const string timeoutMsg = "Backend request timed out or was interrupted before completion. Please retry.";
                    var errMsgId = $"{messageId}:assistant:error";
                    Ui(() => AppendChat("assistant", $"Error: {timeoutMsg}", errMsgId));

                    if (_logger != null)
                    {
                        await _logger.LogAsync("chat.error", new
                        {
                            message_id = messageId,
                            error = timeoutMsg,
                            detail = ex.Message,
                            type = ex.GetType().FullName
                        }, CancellationToken.None).ConfigureAwait(false);
                    }

                    try
                    {
                        if (turnAtFailure != null)
                        {
                            var lastMessageId = $"{turnAtFailure.RootMessageId}:assistant:{Math.Max(1, turnAtFailure.Step)}";
                            await _backendClient.NotifyLoopStopAsync(turnAtFailure.SessionId, lastMessageId, "ERROR", CancellationToken.None).ConfigureAwait(false);
                        }
                    }
                    catch
                    {
                        // ignore
                    }
                }
            }
            catch (Exception ex)
            {
                var errMsgId = $"{messageId}:assistant:error";
                Ui(() => AppendChat("assistant", $"Error: {FormatException(ex)}", errMsgId));
                if (_logger != null)
                {
                    await _logger.LogAsync("chat.error", new
                    {
                        message_id = messageId,
                        error = ex.Message,
                        type = ex.GetType().FullName
                    }, CancellationToken.None).ConfigureAwait(false);
                }
            }
            finally
            {
                _chatLock.Release();

                // If a message was queued while cancelling, send it now.
                if (!string.IsNullOrWhiteSpace(_queuedSendMessageId) && !string.IsNullOrWhiteSpace(_queuedSendText))
                {
                    var qid = _queuedSendMessageId!;
                    var qtext = _queuedSendText!;
                    _queuedSendMessageId = null;
                    _queuedSendText = null;
                    _ = HandleChatSendAsync(qid, qtext, attachments: null, shareWithAgent: true, autoOpenLatestAttachment: false, _reasoningEffort);
                }
            }
        }

        private sealed class BackendStep
        {
            public string AssistantText { get; set; } = "";
            public System.Collections.Generic.List<OperatorActionCall> Actions { get; set; } = new System.Collections.Generic.List<OperatorActionCall>();
        }

        private async Task RunToolLoopAsync(OperatorTurnState turn, string userText, CancellationToken cancellationToken)
        {
            // Hard cap to avoid accidental infinite loops.
            var maxSteps = GetMaxToolLoopSteps();
            for (int i = 0; i < maxSteps; i++)
            {
                cancellationToken.ThrowIfCancellationRequested();
                var toolResults = turn.PendingToolResults.Count > 0 ? new System.Collections.Generic.List<OperatorToolResult>(turn.PendingToolResults) : null;
                turn.PendingToolResults.Clear();

                var stepUserText = i == 0 ? userText : "";
                var stepAttachments = i == 0 ? turn.UserAttachments : null;
                var assistantMessageId = $"{turn.RootMessageId}:assistant:{turn.Step + 1}";

                if (i > 0 && string.IsNullOrWhiteSpace(stepUserText) && (toolResults == null || toolResults.Count == 0))
                {
                    // Nothing new to send to backend; stop cleanly.
                    _activeTurn = null;
                    try { _activeTurnCts?.Dispose(); } catch { }
                    _activeTurnCts = null;
                    Ui(() => { if (_webView?.CoreWebView2 != null) PostToUi("loop.state", new { running = false }); });
                    try { await _backendClient.NotifyLoopStopAsync(turn.SessionId, assistantMessageId, "NO_ACTIONS", CancellationToken.None).ConfigureAwait(false); } catch { }
                    return;
                }

                BackendStep? step;
                try
                {
                    step = await RunBackendStepAsync(turn, assistantMessageId, stepUserText, toolResults, stepAttachments, cancellationToken).ConfigureAwait(false);
                }
                catch (OperationCanceledException)
                {
                    // Preserve tool results so a resumed loop can still send them to the backend.
                    if (toolResults != null && toolResults.Count > 0)
                    {
                        foreach (var tr in toolResults) turn.PendingToolResults.Add(tr);
                    }
                    throw;
                }
                if (step == null)
                {
                    _activeTurn = null;
                    try { _activeTurnCts?.Dispose(); } catch { }
                    _activeTurnCts = null;
                    Ui(() => { if (_webView?.CoreWebView2 != null) PostToUi("loop.state", new { running = false }); });
                    try { await _backendClient.NotifyLoopStopAsync(turn.SessionId, assistantMessageId, "NO_ACTIONS", CancellationToken.None).ConfigureAwait(false); } catch { }
                    return;
                }
                if (turn.AwaitingApproval)
                {
                    try { await _backendClient.NotifyLoopStopAsync(turn.SessionId, assistantMessageId, "AWAITING_APPROVAL", CancellationToken.None).ConfigureAwait(false); } catch { }
                    return;
                }

                if (turn.DryRunOnly && (turn.DryRunMutationAttempted || turn.DryRunOnlyBlockedAction))
                {
                    await StopDryRunOnlyTurnAsync(turn, assistantMessageId).ConfigureAwait(false);
                    return;
                }
            }

            Ui(() => AppendChat("system", $"Stopped after max tool-loop steps ({maxSteps}).", null));
            try
            {
                var lastMessageId = $"{turn.RootMessageId}:assistant:{Math.Max(1, turn.Step)}";
                await _backendClient.NotifyLoopStopAsync(turn.SessionId, lastMessageId, "MAX_STEPS", CancellationToken.None).ConfigureAwait(false);
            }
            catch { }
            finally
            {
                _activeTurn = null;
                try { _activeTurnCts?.Dispose(); } catch { }
                _activeTurnCts = null;
                Ui(() => { if (_webView?.CoreWebView2 != null) PostToUi("loop.state", new { running = false }); });
            }
        }

        private async Task StopDryRunOnlyTurnAsync(OperatorTurnState turn, string assistantMessageId)
        {
            if (turn.DryRunOnlyStopped) return;
            turn.DryRunOnlyStopped = true;

            var message = turn.DryRunOnlyBlockedAction
                ? "Stopped: the model returned an applying action for a dry-run-only request, so Operator blocked it."
                : "Dry-run-only request complete. Operator stopped after the first bounded dry-run mutation attempt.";
            Ui(() => AppendChat("system", message, null));

            if (_logger != null)
            {
                await _logger.LogAsync("loop.guard.dry_run_only", new
                {
                    backend_session_id = turn.SessionId,
                    root_message_id = turn.RootMessageId,
                    message_id = assistantMessageId,
                    mutation_attempted = turn.DryRunMutationAttempted,
                    blocked_applying_action = turn.DryRunOnlyBlockedAction
                }, CancellationToken.None).ConfigureAwait(false);
            }

            _activeTurn = null;
            try { _activeTurnCts?.Dispose(); } catch { }
            _activeTurnCts = null;
            Ui(() => { if (_webView?.CoreWebView2 != null) PostToUi("loop.state", new { running = false }); });
            try { await _backendClient.NotifyLoopStopAsync(turn.SessionId, assistantMessageId, "DRY_RUN_ONLY_COMPLETE", CancellationToken.None).ConfigureAwait(false); } catch { }
        }

        private bool TryConsumeInterject(OperatorTurnState turn, out string interjectMessageId, out string interjectText)
        {
            interjectMessageId = "";
            interjectText = "";

            lock (_interjectGate)
            {
                if (_pendingInterjectTurn != turn) return false;
                if (string.IsNullOrWhiteSpace(_pendingInterjectMessageId) || string.IsNullOrWhiteSpace(_pendingInterjectText)) return false;

                interjectMessageId = _pendingInterjectMessageId!;
                interjectText = _pendingInterjectText!;

                _pendingInterjectTurn = null;
                _pendingInterjectMessageId = null;
                _pendingInterjectText = null;

                return true;
            }
        }

        private async Task LogInterjectAsync(string messageId, string text)
        {
            try
            {
                var sid = _sessionId;
                if (string.IsNullOrWhiteSpace(sid)) return;
                if (_logger == null) return;

                await _logger.LogAsync("chat.user_interject", new
                {
                    backend_session_id = sid,
                    message_id = messageId,
                    text
                }, CancellationToken.None).ConfigureAwait(false);
            }
            catch
            {
                // ignore
            }
        }

        private static bool IsDevModeEnabled()
        {
            var v = Environment.GetEnvironmentVariable("OPERATOR_DEV_MODE");
            if (string.IsNullOrWhiteSpace(v)) return true;
            return string.Equals(v, "1", StringComparison.OrdinalIgnoreCase) ||
                   string.Equals(v, "true", StringComparison.OrdinalIgnoreCase) ||
                   string.Equals(v, "yes", StringComparison.OrdinalIgnoreCase);
        }

        private static int GetMaxToolTimeMs()
        {
            var raw = Environment.GetEnvironmentVariable("OPERATOR_MAX_TOOL_TIME_MS");
            if (string.IsNullOrWhiteSpace(raw)) return 120000;
            if (!int.TryParse(raw.Trim(), out var parsed)) return 120000;
            if (parsed < 1000) return 1000;
            // Keep a conservative hard cap unless in dev mode.
            var hardCap = IsDevModeEnabled() ? 900000 : 300000;
            if (parsed > hardCap) return hardCap;
            return parsed;
        }

        private static int GetMaxToolLoopSteps()
        {
            const int @default = 50;
            var v = Environment.GetEnvironmentVariable("OPERATOR_MAX_TOOL_STEPS");
            if (string.IsNullOrWhiteSpace(v)) return @default;

            if (!int.TryParse(v.Trim(), out var parsed)) return @default;
            if (parsed < 1) return 1;

            // In normal mode, keep a conservative cap. In dev mode allow more.
            var hardCap = IsDevModeEnabled() ? 100 : 50;
            if (parsed > hardCap) return hardCap;
            return parsed;
        }

        private static int GetPreChatContextTimeoutMs()
        {
            const int @default = 4000;
            var raw = Environment.GetEnvironmentVariable("OPERATOR_PRECHAT_CONTEXT_TIMEOUT_MS");
            if (string.IsNullOrWhiteSpace(raw)) return @default;
            if (!int.TryParse(raw.Trim(), out var parsed)) return @default;
            if (parsed < 250) return 250;
            if (parsed > 30000) return 30000;
            return parsed;
        }

        private async Task<object?> TryGetPreChatRevitContextAsync(string messageId)
        {
            var timeoutMs = GetPreChatContextTimeoutMs();
            using var cts = new CancellationTokenSource(timeoutMs);
            try
            {
                return await _eventService.Run(
                    app => new ContextHandler().Handle(app, "").GetAwaiter().GetResult(),
                    cts.Token).ConfigureAwait(false);
            }
            catch (OperationCanceledException ex)
            {
                if (_logger != null)
                {
                    await _logger.LogAsync("context.timeout", new
                    {
                        message_id = messageId,
                        timeout_ms = timeoutMs,
                        error = ex.Message
                    }, CancellationToken.None).ConfigureAwait(false);
                }

                Ui(() => AppendChat("system", "Revit context snapshot timed out; continuing with tool-based context.", null));
                return null;
            }
            catch (Exception ex)
            {
                if (_logger != null)
                {
                    await _logger.LogAsync("context.error", new
                    {
                        message_id = messageId,
                        error = ex.Message,
                        type = ex.GetType().FullName
                    }, CancellationToken.None).ConfigureAwait(false);
                }

                return null;
            }
        }

        private static bool IsImportantAssistantProgress(string text)
        {
            var lower = (text ?? "").ToLowerInvariant();
            return lower.Contains("blocked") ||
                   lower.Contains("failed") ||
                   lower.Contains("invalid") ||
                   lower.Contains("rolled back") ||
                   lower.Contains("warning") ||
                   lower.Contains("approval") ||
                   lower.Contains("stopped") ||
                   lower.Contains("could not") ||
                   lower.Contains("need ");
        }

        private static bool ShouldDisplayAssistantStepMessage(OperatorTurnState turn, string text, int actionCount)
        {
            if (string.IsNullOrWhiteSpace(text)) return false;
            if (actionCount == 0) return true;
            if (turn.Step <= 1) return true;
            if (turn.VisibleAssistantProgressCount >= 2) return false;
            return IsImportantAssistantProgress(text);
        }

        private void DisplayAssistantStepMessageIfNeeded(OperatorTurnState turn, string assistantMessageId, string text, int actionCount)
        {
            if (!ShouldDisplayAssistantStepMessage(turn, text, actionCount)) return;
            if (actionCount > 0) turn.VisibleAssistantProgressCount++;
            Ui(() => AppendChat("assistant", text, assistantMessageId));
        }

        private async Task<BackendStep?> RunBackendStepAsync(
            OperatorTurnState turn,
            string assistantMessageId,
            string userText,
            System.Collections.Generic.List<OperatorToolResult>? toolResults,
            System.Collections.Generic.List<OperatorUserAttachment>? userAttachments,
            CancellationToken cancellationToken)
        {
            turn.Step++;
            await EnsureBackendRunningAsync(cancellationToken).ConfigureAwait(false);
            turn.Context = RefreshContextForStep(turn.Context);

            var assistantText = "";
            var actions = new System.Collections.Generic.List<OperatorActionCall>();

            if (_webViewReady)
            {
                try
                {
                    await _backendClient.ChatStreamToCallbacksAsync(
                        turn.SessionId,
                        assistantMessageId,
                        userText,
                        turn.Context,
                        toolResults,
                        userAttachments,
                        onEvent: ev =>
                        {
                            cancellationToken.ThrowIfCancellationRequested();
                            if (string.Equals(ev.EventName, "assistant.delta", StringComparison.OrdinalIgnoreCase))
                            {
                                using var doc = JsonDocument.Parse(ev.DataJson);
                                var delta = doc.RootElement.TryGetProperty("text", out var t) ? t.GetString() : null;
                                if (!string.IsNullOrEmpty(delta))
                                {
                                    assistantText += delta;
                                }
                                return;
                            }

                            if (string.Equals(ev.EventName, "chat.start", StringComparison.OrdinalIgnoreCase))
                            {
                                using var doc = JsonDocument.Parse(ev.DataJson);
                                var sessionId = doc.RootElement.TryGetProperty("session_id", out var s) ? s.GetString() : null;
                                var messageId = doc.RootElement.TryGetProperty("message_id", out var m) ? m.GetString() : null;
                                Ui(() => PostToUi("chat.start", new { session_id = sessionId, message_id = messageId }));
                                return;
                            }

                            if (string.Equals(ev.EventName, "heartbeat", StringComparison.OrdinalIgnoreCase))
                            {
                                using var doc = JsonDocument.Parse(ev.DataJson);
                                var ts = doc.RootElement.TryGetProperty("ts", out var h) ? h.GetString() : null;
                                Ui(() => PostToUi("heartbeat", new { ts }));
                                return;
                            }

                            if (string.Equals(ev.EventName, "assistant.done", StringComparison.OrdinalIgnoreCase))
                            {
                                using var doc = JsonDocument.Parse(ev.DataJson);
                                var text = doc.RootElement.TryGetProperty("text", out var d) ? d.GetString() : null;
                                if (!string.IsNullOrWhiteSpace(text))
                                {
                                    if (string.IsNullOrEmpty(assistantText))
                                    {
                                        assistantText = text;
                                    }
                                    else if (text.StartsWith(assistantText, StringComparison.Ordinal) && text.Length > assistantText.Length)
                                    {
                                        assistantText = text;
                                    }
                                }
                                return;
                            }

                            if (string.Equals(ev.EventName, "actions", StringComparison.OrdinalIgnoreCase))
                            {
                                using var doc = JsonDocument.Parse(ev.DataJson);
                                if (doc.RootElement.TryGetProperty("actions", out var arr) && arr.ValueKind == JsonValueKind.Array)
                                {
                                    var parsed = JsonSerializer.Deserialize<System.Collections.Generic.List<OperatorActionCall>>(arr.GetRawText(), OperatorUiProtocol.JsonOptions);
                                    if (parsed != null)
                                    {
                                        FreezeActionBodiesInPlace(parsed);
                                        actions.AddRange(parsed);
                                    }
                                }
                                return;
                            }

                            if (string.Equals(ev.EventName, "error", StringComparison.OrdinalIgnoreCase))
                            {
                                using var doc = JsonDocument.Parse(ev.DataJson);
                                var err = doc.RootElement.TryGetProperty("error", out var e) ? e.GetString() : ev.DataJson;
                                Ui(() => AppendChat("system", $"Backend stream error: {err}", null));
                            }
                        },
                        cancellationToken).ConfigureAwait(false);
                }
                catch (Exception ex) when (!(ex is OperationCanceledException))
                {
                    try
                    {
                var resp = await _backendClient.ChatAsync(
                    turn.SessionId,
                    assistantMessageId,
                    userText,
                    turn.Context,
                    toolResults,
                    userAttachments,
                    cancellationToken).ConfigureAwait(false);

                        assistantText = resp.AssistantMessage ?? "";
                        actions = resp.Actions ?? new System.Collections.Generic.List<OperatorActionCall>();
                        FreezeActionBodiesInPlace(actions);
                        Ui(() => AppendChat("system", $"Streaming failed; used non-streaming: {FormatException(ex)}", null));
                    }
                    catch (Exception ex2) when (IsBackendConnectionFailure(ex2))
                    {
                        // Backend may have been stopped/restarted mid-loop. Try once to auto-start and retry.
                        Ui(() => AppendChat("system", $"Backend connection failed; retrying: {FormatException(ex2)}", null));
                        await EnsureBackendRunningAsync(cancellationToken).ConfigureAwait(false);
                        var resp = await _backendClient.ChatAsync(
                            turn.SessionId,
                            assistantMessageId,
                            userText,
                            turn.Context,
                            toolResults,
                            userAttachments,
                            cancellationToken).ConfigureAwait(false);

                        assistantText = resp.AssistantMessage ?? "";
                        actions = resp.Actions ?? new System.Collections.Generic.List<OperatorActionCall>();
                        FreezeActionBodiesInPlace(actions);
                    }
                }

                DisplayAssistantStepMessageIfNeeded(turn, assistantMessageId, assistantText, actions.Count);
                Ui(() => PostToUi("chat.done", new { messageId = assistantMessageId }));
            }
            else
            {
                try
                {
                    var resp = await _backendClient.ChatAsync(
                        turn.SessionId,
                        assistantMessageId,
                        userText,
                        turn.Context,
                        toolResults,
                        userAttachments,
                        cancellationToken).ConfigureAwait(false);
                    assistantText = resp.AssistantMessage ?? "";
                    actions = resp.Actions ?? new System.Collections.Generic.List<OperatorActionCall>();
                    FreezeActionBodiesInPlace(actions);
                    DisplayAssistantStepMessageIfNeeded(turn, assistantMessageId, assistantText, actions.Count);
                }
                catch (Exception ex2) when (IsBackendConnectionFailure(ex2))
                {
                    // Backend may have been stopped/restarted mid-loop. Try once to auto-start and retry with the same context.
                    Ui(() => AppendChat("system", $"Backend connection failed; retrying: {FormatException(ex2)}", null));
                    await EnsureBackendRunningAsync(cancellationToken).ConfigureAwait(false);

                    var resp = await _backendClient.ChatAsync(
                        turn.SessionId,
                        assistantMessageId,
                        userText,
                        turn.Context,
                        toolResults,
                        userAttachments,
                        cancellationToken).ConfigureAwait(false);
                    assistantText = resp.AssistantMessage ?? "";
                    actions = resp.Actions ?? new System.Collections.Generic.List<OperatorActionCall>();
                    FreezeActionBodiesInPlace(actions);
                    DisplayAssistantStepMessageIfNeeded(turn, assistantMessageId, assistantText, actions.Count);
                }
            }

            await _logger!.LogAsync("chat.backend", new
            {
                backend_session_id = turn.SessionId,
                root_message_id = turn.RootMessageId,
                message_id = assistantMessageId,
                user_text = userText,
                tool_results = toolResults,
                assistant_message = assistantText,
                actions
            }, CancellationToken.None).ConfigureAwait(false);

            if (actions.Count == 0) return null;

            var actionPlanSignature = BuildActionPlanSignature(actions);
            if (!string.IsNullOrWhiteSpace(actionPlanSignature))
            {
                if (string.Equals(turn.LastActionPlanSignature, actionPlanSignature, StringComparison.Ordinal))
                {
                    turn.RepeatedActionPlanCount++;
                }
                else
                {
                    turn.LastActionPlanSignature = actionPlanSignature;
                    turn.RepeatedActionPlanCount = 1;
                }

                // Stop deterministic no-progress loops: an identical plan repeated after either
                // all-failed or all-successful prior results cannot advance without new evidence.
                if (turn.RepeatedActionPlanCount >= 3 &&
                    (ToolResultsAllFailed(toolResults) || ToolResultsAllSucceeded(toolResults)))
                {
                    var loopMsg = ToolResultsAllFailed(toolResults)
                        ? "Stopped repeated failing action loop (same plan returned multiple times after failed results)."
                        : "Stopped repeated successful action loop (same plan returned multiple times without advancing).";
                    Ui(() => AppendChat("system", loopMsg, null));
                    await _logger!.LogAsync("loop.guard.repeat_plan", new
                    {
                        backend_session_id = turn.SessionId,
                        root_message_id = turn.RootMessageId,
                        message_id = assistantMessageId,
                        repeat_count = turn.RepeatedActionPlanCount
                    }, CancellationToken.None).ConfigureAwait(false);
                    return null;
                }
            }
            else
            {
                turn.LastActionPlanSignature = "";
                turn.RepeatedActionPlanCount = 0;
            }

            var toolResultsForThisStep = new System.Collections.Generic.List<OperatorToolResult>();
            turn.DeferredActions.Clear();
            turn.WriteAppliedInStep = false;

            // Deterministic Plan→Apply→Verify: if this step contains any write (high risk) or any pending approvals,
            // defer capture/verify actions until after writes/approvals complete and the document is regenerated.
            var stepHasWriteActions = actions.Any(a => GetActionRisk(a) == OperatorActionRisk.High);
            var stepHasApprovals = actions.Any(a => OperatorApprovalPolicy.RequiresApproval(_approvalMode, GetActionRisk(a)));

            foreach (var action in actions)
            {
                var actionId = string.IsNullOrWhiteSpace(action.ActionId) ? Guid.NewGuid().ToString("N") : action.ActionId;
                var title = $"{(action.Method ?? "").Trim().ToUpperInvariant()} {action.Path}";
                action.ActionId = actionId;

                var risk = GetActionRisk(action);
                var needsApproval = OperatorApprovalPolicy.RequiresApproval(_approvalMode, risk);
                Ui(() => AddAction(actionId, title, action.Path, action.Body, needsApproval, risk));

                if (turn.DryRunOnly && risk != OperatorActionRisk.Low)
                {
                    var bodyJson = action.Body is JsonElement dryRunBody
                        ? dryRunBody.GetRawText()
                        : JsonSerializer.Serialize(action.Body, OperatorUiProtocol.JsonOptions);
                    var explicitlyDryRun = OperatorDryRunTurnPolicy.BodyRequestsDryRun(bodyJson);
                    if (!explicitlyDryRun || turn.DryRunMutationAttempted)
                    {
                        turn.DryRunOnlyBlockedAction = true;
                        var guardError = !explicitlyDryRun
                            ? "Blocked by the user's dry-run-only instruction: this action could apply changes."
                            : "Blocked by the user's dry-run-only instruction: only one bounded dry-run mutation attempt is allowed.";
                        Ui(() => UpdateActionStatus(actionId, "blocked", guardError));
                        var guardException = new InvalidOperationException(guardError);
                        toolResultsForThisStep.Add(await BuildToolResultAsync(action, DateTime.UtcNow, result: null, guardException).ConfigureAwait(false));
                        await _logger!.LogAsync("loop.guard.dry_run_action_blocked", new
                        {
                            backend_session_id = turn.SessionId,
                            root_message_id = turn.RootMessageId,
                            message_id = assistantMessageId,
                            action_id = actionId,
                            method = action.Method,
                            path = action.Path,
                            explicitly_dry_run = explicitlyDryRun,
                            prior_dry_run_attempt = turn.DryRunMutationAttempted
                        }, CancellationToken.None).ConfigureAwait(false);
                        continue;
                    }

                    turn.DryRunMutationAttempted = true;
                }

                if (needsApproval)
                {
                    turn.AwaitingApproval = true;
                    turn.PendingApprovals++;
                    _pendingApprovals[actionId] = action;
                    _turnByApprovalActionId[actionId] = turn;
                    Ui(() => UpdateActionStatus(actionId, "needs_approval", null));
                    _ = TryPlanPendingActionAsync(actionId, action);
                    continue;
                }

                if (IsCaptureLikePath(action.Path) && (stepHasWriteActions || stepHasApprovals))
                {
                    // Defer capture/verify actions until after writes/approvals complete to avoid stale evidence.
                    turn.DeferredActions.Add(action);
                    Ui(() => UpdateActionStatus(actionId, "deferred", "Will run after apply + regenerate."));
                    continue;
                }

                Ui(() => UpdateActionStatus(actionId, "pending", null));
                var startedAt = DateTime.UtcNow;
                try
                {
                    Ui(() => UpdateActionStatus(actionId, "running", null));
                    await _logger!.LogAsync("action.request", new
                    {
                        backend_session_id = turn.SessionId,
                        root_message_id = turn.RootMessageId,
                        message_id = assistantMessageId,
                        action_id = actionId,
                        method = action.Method,
                        path = action.Path,
                        body = action.Body
                    }, CancellationToken.None).ConfigureAwait(false);

                    cancellationToken.ThrowIfCancellationRequested();
                    var result = await ExecuteActionAsync(action, cancellationToken).ConfigureAwait(false);
                    Ui(() => SetActionResult(actionId, result));
                    Ui(() => UpdateActionStatus(actionId, "done", null));
                    toolResultsForThisStep.Add(await BuildToolResultAsync(action, startedAt, result, null).ConfigureAwait(false));

                    if (risk == OperatorActionRisk.High)
                    {
                        turn.WriteAppliedInStep = true;
                    }

                    // If we just applied titleblock parameter updates, enqueue a sheet-aware verify capture.
                    if (string.Equals(action.Path, "/revit/set-parameter", StringComparison.OrdinalIgnoreCase))
                    {
                        if (TryGetTitleblockSheetIdsFromSetParameterResult(result, out var sheetIds))
                        {
                            foreach (var sid in sheetIds.Take(2))
                            {
                                var verify = new OperatorActionCall
                                {
                                    ActionId = $"{actionId}:__verify_titleblock:{sid}",
                                    Method = "POST",
                                    Path = "/revit/capture-sheet-region",
                                    Body = new { sheetViewId = sid, region = "titleblock", marginFt = 0.15, imageMaxSizePx = 2400, includeMapping = true, fileName = $"verify_titleblock_{sid}" }
                                };
                                // Always defer these until after regenerate (even if there are no approvals).
                                try
                                {
                                    var rid = GetActionRisk(verify);
                                    Ui(() => AddAction(verify.ActionId, "POST /revit/capture-sheet-region (verify titleblock)", verify.Path, verify.Body, false, rid));
                                    Ui(() => UpdateActionStatus(verify.ActionId, "deferred", "Will run after apply + regenerate."));
                                }
                                catch { }
                                turn.DeferredActions.Add(verify);
                            }
                        }
                    }

                    // Verification hook: after certain state-changing actions, capture a screenshot for the model/user.
                    await TryAutoCaptureAfterAsync(turn, action, actionId, toolResultsForThisStep).ConfigureAwait(false);

                    await _logger!.LogAsync("action.done", new
                    {
                        backend_session_id = turn.SessionId,
                        root_message_id = turn.RootMessageId,
                        message_id = assistantMessageId,
                        action_id = actionId,
                        method = action.Method,
                        path = action.Path,
                        approval_mode = _approvalMode.ToString(),
                        required_approval = false,
                        granted = true,
                        started_at = startedAt.ToString("o"),
                        finished_at = DateTime.UtcNow.ToString("o"),
                        duration_ms = (int)Math.Max(0, (DateTime.UtcNow - startedAt).TotalMilliseconds),
                        result
                    }, CancellationToken.None).ConfigureAwait(false);
                }
                catch (Exception ex)
                {
                    var err = FormatException(ex);
                    Ui(() => UpdateActionStatus(actionId, "failed", err));
                    toolResultsForThisStep.Add(await BuildToolResultAsync(action, startedAt, result: null, ex).ConfigureAwait(false));
                    await _logger!.LogAsync("action.failed", new
                    {
                        backend_session_id = turn.SessionId,
                        root_message_id = turn.RootMessageId,
                        message_id = assistantMessageId,
                        action_id = actionId,
                        method = action.Method,
                        path = action.Path,
                        approval_mode = _approvalMode.ToString(),
                        required_approval = false,
                        granted = true,
                        duration_ms = (int)Math.Max(0, (DateTime.UtcNow - startedAt).TotalMilliseconds),
                        error = err,
                        type = ex.GetType().FullName
                    }, CancellationToken.None).ConfigureAwait(false);
                }
            }

            if (turn.AwaitingApproval)
            {
                if (toolResultsForThisStep.Count > 0) turn.PendingToolResults.AddRange(toolResultsForThisStep);
                Ui(() => AppendChat("system", "Actions pending approval. Approve to continue.", null));
            }
            else
            {
                // No approvals pending: run any deferred verification now (after optional regenerate).
                await TryRunDeferredVerificationAsync(turn, assistantMessageId, toolResultsForThisStep).ConfigureAwait(false);
                if (toolResultsForThisStep.Count > 0) turn.PendingToolResults.AddRange(toolResultsForThisStep);
            }

            return new BackendStep { AssistantText = assistantText, Actions = actions };
        }

        private async Task<object> ExecuteActionAsync(OperatorActionCall action, CancellationToken cancellationToken)
        {
            var method = (action.Method ?? "").Trim().ToUpperInvariant();
            var path = (action.Path ?? "").Trim();

            if (string.Equals(path, "/ui/open", StringComparison.OrdinalIgnoreCase))
            {
                if (!OperatorActionAllowlist.IsAllowed(method, path))
                    throw new InvalidOperationException($"Action not allowlisted: {method} {path}");
                OperatorActionSchemaValidator.ValidateOrThrow(action);
                if (!string.Equals(method, "POST", StringComparison.OrdinalIgnoreCase))
                    throw new InvalidOperationException("ui.open requires POST.");
                return await ExecuteUiOpenActionAsync(action, cancellationToken).ConfigureAwait(false);
            }

            if (string.Equals(path, "/ui/close", StringComparison.OrdinalIgnoreCase))
            {
                if (!OperatorActionAllowlist.IsAllowed(method, path))
                    throw new InvalidOperationException($"Action not allowlisted: {method} {path}");
                OperatorActionSchemaValidator.ValidateOrThrow(action);
                if (!string.Equals(method, "POST", StringComparison.OrdinalIgnoreCase))
                    throw new InvalidOperationException("ui.close requires POST.");
                return await ExecuteUiCloseActionAsync(action).ConfigureAwait(false);
            }

            if (string.Equals(path, "/revit/capture-screenshare", StringComparison.OrdinalIgnoreCase))
            {
                if (!OperatorActionAllowlist.IsAllowed(method, path))
                    throw new InvalidOperationException($"Action not allowlisted: {method} {path}");
                OperatorActionSchemaValidator.ValidateOrThrow(action);
                if (!string.Equals(method, "POST", StringComparison.OrdinalIgnoreCase))
                    throw new InvalidOperationException("capture-screenshare requires POST.");
                return await ExecuteCaptureScreenshareActionAsync(action, cancellationToken).ConfigureAwait(false);
            }

            if (string.Equals(path, "/revit/batch-job", StringComparison.OrdinalIgnoreCase))
            {
                if (!OperatorActionAllowlist.IsAllowed(method, path))
                    throw new InvalidOperationException($"Action not allowlisted: {method} {path}");
                OperatorActionSchemaValidator.ValidateOrThrow(action);
                if (!string.Equals(method, "POST", StringComparison.OrdinalIgnoreCase))
                    throw new InvalidOperationException("batch-job requires POST.");
                return await ExecuteRevitBatchJobActionAsync(action, cancellationToken).ConfigureAwait(false);
            }

            if (string.Equals(path, "/revit/batch-control", StringComparison.OrdinalIgnoreCase))
            {
                if (!OperatorActionAllowlist.IsAllowed(method, path))
                    throw new InvalidOperationException($"Action not allowlisted: {method} {path}");
                OperatorActionSchemaValidator.ValidateOrThrow(action);
                if (!string.Equals(method, "POST", StringComparison.OrdinalIgnoreCase))
                    throw new InvalidOperationException("batch-control requires POST.");
                return await ExecuteRevitBatchControlActionAsync(action, cancellationToken).ConfigureAwait(false);
            }

            return await _actionRunner.ExecuteAsync(action, cancellationToken).ConfigureAwait(false);
        }

        private async Task<object> ExecuteCaptureScreenshareActionAsync(OperatorActionCall action, CancellationToken cancellationToken)
        {
            cancellationToken.ThrowIfCancellationRequested();

            var includeContext = true;
            try
            {
                if (action.Body is JsonElement je && je.ValueKind == JsonValueKind.Object)
                {
                    if (je.TryGetProperty("includeContext", out var ic) && (ic.ValueKind == JsonValueKind.True || ic.ValueKind == JsonValueKind.False))
                        includeContext = ic.GetBoolean();
                }
            }
            catch
            {
                includeContext = true;
            }

            ScreenshareContextResult? preCtx = null;
            if (!includeContext)
            {
                preCtx = new ScreenshareContextResult
                {
                    Context = new
                    {
                        captured_at = DateTime.UtcNow.ToString("o"),
                        note = "Context capture disabled by includeContext=false."
                    },
                    Signature = "manual_no_context"
                };
            }

            var cap = await CaptureScreenshareAsync(preCtx).ConfigureAwait(false);
            TrackScreenshareFilesForActiveChat(cap.Saved);
            TryCleanupScreenshareUploads(deleteAllScreenshares: false, ttl: ScreenshareTtl);

            var image = cap.Saved.FirstOrDefault(s => !string.IsNullOrWhiteSpace(s.Mime) && s.Mime.StartsWith("image/", StringComparison.OrdinalIgnoreCase))
                        ?? cap.Saved.FirstOrDefault(s => LooksLikeImagePath(s.FullPath));
            var context = cap.Saved.FirstOrDefault(s => string.Equals(s.Mime, "application/json", StringComparison.OrdinalIgnoreCase));

            return new
            {
                ok = true,
                kind = "screenshare",
                captured_at = DateTime.UtcNow.ToString("o"),
                path = image?.FullPath,
                relative_path = image?.RelativePath,
                context_path = context?.FullPath,
                context_relative_path = context?.RelativePath,
                files = cap.Saved.Select(s => new
                {
                    id = s.Id,
                    path = s.FullPath,
                    relative_path = s.RelativePath,
                    filename = s.FileName,
                    bytes = s.Bytes,
                    mime = s.Mime,
                    created_at = s.CreatedAt
                }).ToArray()
            };
        }

        private async Task<object> ExecuteRevitBatchJobActionAsync(OperatorActionCall action, CancellationToken cancellationToken)
        {
            cancellationToken.ThrowIfCancellationRequested();
            var body = ToJsonObjectBestEffort(action.Body);
            var jobType = GetJsonString(body, "job_type", 64);
            if (string.IsNullOrWhiteSpace(jobType)) jobType = "delegated_revit_task_batch";
            if (!string.Equals(jobType, "delegated_revit_task_batch", StringComparison.OrdinalIgnoreCase))
                throw new InvalidOperationException("The Revit pane currently supports delegated_revit_task_batch for agent-initiated batch runs.");

            var taskPrompt = GetJsonString(body, "task_prompt", 4000);
            if (string.IsNullOrWhiteSpace(taskPrompt))
                throw new InvalidOperationException("batch-job requires task_prompt.");

            await EnsureBackendRunningAsync(cancellationToken).ConfigureAwait(false);
            var sourceSessionId = await EnsureSessionAsync().ConfigureAwait(false);

            var plannerPayload = new
            {
                title = GetJsonString(body, "title", 160),
                task_prompt = taskPrompt,
                scope_description = GetJsonString(body, "scope_description", 2000),
                work_item_hint = GetJsonString(body, "work_item_hint", 800),
                preview_count = GetJsonInt(body, "preview_count", 3, 1, 10),
                max_items = GetJsonInt(body, "max_items", 50, 1, 300),
                success_checks = GetJsonStringArray(body, "success_checks", 20)
            };

            var plannedJson = await _backendClient.PlanDelegatedRevitBatchJsonAsync(plannerPayload, cancellationToken).ConfigureAwait(false);
            var planned = ParseJsonObjectBestEffort(plannedJson);
            if (planned.Count == 0)
                throw new InvalidOperationException("Batch planner did not return a valid plan.");

            var createPayload = ToJsonObjectBestEffort(planned);
            var approval = GetJsonObject(createPayload, "approval");
            var requireApproval = GetJsonBool(body, "require_approval") ?? (_approvalMode == OperatorApprovalMode.Safe);
            approval["required"] = requireApproval;
            createPayload["approval"] = approval;

            var source = GetJsonObject(createPayload, "source");
            source["session_id"] = sourceSessionId;
            source["frontend"] = "revit_pane";
            source["requested_from_tool"] = true;
            createPayload["source"] = source;
            createPayload["executor_kind"] = "revit_delegate";

            var createdJson = await _backendClient.CreateRevitBatchJobJsonAsync(JsonNodeToObject(createPayload), cancellationToken).ConfigureAwait(false);
            var created = ParseJsonObjectBestEffort(createdJson);
            var job = GetJsonObject(created, "job");
            var status = GetJsonString(job, "status", 64);
            if (string.Equals(status, "queued", StringComparison.OrdinalIgnoreCase) ||
                string.Equals(status, "running", StringComparison.OrdinalIgnoreCase))
            {
                PokeRevitBatchWorker();
            }

            return new
            {
                ok = true,
                job = JsonNodeToObject(job),
                batch_mode = true,
                worker_started = string.Equals(status, "queued", StringComparison.OrdinalIgnoreCase) ||
                                 string.Equals(status, "running", StringComparison.OrdinalIgnoreCase)
            };
        }

        private async Task<object> ExecuteRevitBatchControlActionAsync(OperatorActionCall action, CancellationToken cancellationToken)
        {
            cancellationToken.ThrowIfCancellationRequested();
            var body = ToJsonObjectBestEffort(action.Body);
            var jobId = GetJsonString(body, "job_id", 120);
            if (string.IsNullOrWhiteSpace(jobId))
                throw new InvalidOperationException("batch-control requires job_id.");

            var operation = GetJsonString(body, "operation", 32).Replace("_", "-");
            if (string.IsNullOrWhiteSpace(operation))
                throw new InvalidOperationException("batch-control requires operation.");

            await EnsureBackendRunningAsync(cancellationToken).ConfigureAwait(false);
            var controlledJson = await _backendClient.ControlRevitBatchJobJsonAsync(jobId, operation, cancellationToken).ConfigureAwait(false);
            var controlled = ParseJsonObjectBestEffort(controlledJson);
            var job = GetJsonObject(controlled, "job");
            if (string.Equals(operation, "approve", StringComparison.OrdinalIgnoreCase) ||
                string.Equals(operation, "resume", StringComparison.OrdinalIgnoreCase) ||
                string.Equals(operation, "retry-failed", StringComparison.OrdinalIgnoreCase))
            {
                PokeRevitBatchWorker();
            }

            return new
            {
                ok = true,
                job = JsonNodeToObject(job),
                operation = operation.Replace("-", "_")
            };
        }

        private void EnsureRevitBatchWorkerStarted()
        {
            if (_revitBatchWorkerStarted) return;
            _revitBatchWorkerStarted = true;
            _revitBatchWorkerTimer = new System.Threading.Timer(_ => _ = TryRunRevitBatchWorkerOnceAsync(), null, TimeSpan.FromSeconds(2), TimeSpan.FromSeconds(2));
        }

        private void PokeRevitBatchWorker()
        {
            EnsureRevitBatchWorkerStarted();
            _ = TryRunRevitBatchWorkerOnceAsync();
        }

        private async Task TryRunRevitBatchWorkerOnceAsync()
        {
            if (!_revitBatchWorkerLock.Wait(0)) return;
            try
            {
                if (_turnBusy || _activeTurn != null || _pendingApprovals.Count > 0) return;
                await EnsureBackendRunningAsync(CancellationToken.None).ConfigureAwait(false);
                EnsureRevitBatchWorkerStarted();

                while (!_turnBusy && _activeTurn == null && _pendingApprovals.Count == 0)
                {
                    var claimJson = await _backendClient.ClaimNextRevitBatchItemJsonAsync(
                        _revitBatchExecutorId,
                        "revit_delegate",
                        jobId: null,
                        CancellationToken.None).ConfigureAwait(false);
                    var claim = ParseJsonObjectBestEffort(claimJson);
                    var job = GetJsonObject(claim, "job");
                    var item = GetJsonObject(claim, "item");
                    if (job.Count == 0 || item.Count == 0) break;
                    var claimToken = GetJsonString(claim, "claim_token", 160);
                    if (string.IsNullOrWhiteSpace(claimToken))
                        throw new InvalidOperationException("Batch claim response is missing claim_token; refusing to execute the claimed item.");
                    var itemClaim = GetJsonObject(item, "claim");
                    var fencingToken = GetJsonString(itemClaim, "fencing_token", 160);
                    if (!string.IsNullOrWhiteSpace(fencingToken) && !string.Equals(fencingToken, claimToken, StringComparison.Ordinal))
                        throw new InvalidOperationException("Batch claim response token does not match item.claim.fencing_token; refusing to execute the claimed item.");
                    await ProcessClaimedRevitBatchItemAsync(job, item, claimToken, CancellationToken.None).ConfigureAwait(false);
                }
            }
            catch (Exception ex)
            {
                try
                {
                    await (_logger?.LogAsync("batch.worker.error", new { error = FormatException(ex) }, CancellationToken.None)
                        ?? Task.CompletedTask).ConfigureAwait(false);
                }
                catch
                {
                    // ignore
                }
            }
            finally
            {
                _revitBatchWorkerLock.Release();
            }
        }

        private async Task ProcessClaimedRevitBatchItemAsync(JsonObject job, JsonObject item, string claimToken, CancellationToken cancellationToken)
        {
            var jobId = GetJsonString(job, "id", 120);
            var itemId = GetJsonString(item, "id", 120);
            if (string.IsNullOrWhiteSpace(jobId) || string.IsNullOrWhiteSpace(itemId)) return;
            if (string.IsNullOrWhiteSpace(claimToken))
                throw new InvalidOperationException("Batch claim_token is required before item execution.");

            try
            {
                object result;
                var jobType = GetJsonString(job, "job_type", 64);
                if (string.Equals(jobType, "delegated_revit_task_batch", StringComparison.OrdinalIgnoreCase))
                {
                    result = await ExecuteDelegatedRevitBatchItemAsync(job, item, cancellationToken).ConfigureAwait(false);
                }
                else
                {
                    throw new InvalidOperationException($"Unsupported Revit batch job type for this executor: {jobType}");
                }

                await _backendClient.CompleteRevitBatchItemJsonAsync(jobId, itemId, _revitBatchExecutorId, claimToken, result, cancellationToken).ConfigureAwait(false);
            }
            catch (Exception ex)
            {
                await _backendClient.FailRevitBatchItemJsonAsync(
                    jobId,
                    itemId,
                    _revitBatchExecutorId,
                    claimToken,
                    FormatException(ex),
                    new { error = FormatException(ex) },
                    cancellationToken).ConfigureAwait(false);
            }
        }

        private async Task<object> ExecuteDelegatedRevitBatchItemAsync(JsonObject job, JsonObject item, CancellationToken cancellationToken)
        {
            var taskPrompt = GetJsonString(item, "task_prompt", 4000);
            if (string.IsNullOrWhiteSpace(taskPrompt))
                throw new InvalidOperationException("Delegated batch item is missing task_prompt.");

            var jobId = GetJsonString(job, "id", 120);
            var itemId = GetJsonString(item, "id", 120);
            var paramsObj = GetJsonObject(job, "params");
            var perItemMaxRounds = GetJsonInt(paramsObj, "per_item_max_rounds", 8, 1, 24);
            var batchSessionId = await _backendClient.CreateSessionAsync(cancellationToken).ConfigureAwait(false);
            var context = RefreshContextForStep(new
            {
                ui = new
                {
                    client = "revit-pane-batch-worker",
                    surface = "revit-pane",
                    lane = "batch"
                },
                batch = new
                {
                    job_id = jobId,
                    item_id = itemId,
                    item_index = GetJsonInt(item, "index", 0, 0, 100000),
                    item_label = GetJsonString(item, "label", 160),
                    total_items = GetJsonSummaryTotal(job)
                }
            });

            var userText = taskPrompt;
            var toolResults = new System.Collections.Generic.List<OperatorToolResult>();
            var lastAssistantMessage = "";
            var lastPlanSignature = "";
            var repeatedPlanCount = 0;
            var rounds = new System.Collections.Generic.List<object>();

            for (int round = 0; round < perItemMaxRounds; round++)
            {
                cancellationToken.ThrowIfCancellationRequested();
                await EnsureBackendRunningAsync(cancellationToken).ConfigureAwait(false);

                OperatorChatResponse response;
                try
                {
                    response = await _backendClient.ChatAsync(
                        batchSessionId,
                        $"{jobId}:batch:{itemId}:{round + 1}",
                        userText,
                        context,
                        toolResults.Count == 0 ? null : toolResults,
                        userAttachments: null,
                        cancellationToken).ConfigureAwait(false);
                }
                catch (Exception ex) when (IsBackendConnectionFailure(ex))
                {
                    await EnsureBackendRunningAsync(cancellationToken).ConfigureAwait(false);
                    response = await _backendClient.ChatAsync(
                        batchSessionId,
                        $"{jobId}:batch:{itemId}:{round + 1}",
                        userText,
                        context,
                        toolResults.Count == 0 ? null : toolResults,
                        userAttachments: null,
                        cancellationToken).ConfigureAwait(false);
                }

                var actions = response.Actions ?? new System.Collections.Generic.List<OperatorActionCall>();
                FreezeActionBodiesInPlace(actions);
                lastAssistantMessage = response.AssistantMessage ?? "";
                rounds.Add(new
                {
                    round = round + 1,
                    assistant_message = lastAssistantMessage,
                    action_count = actions.Count
                });

                if (actions.Count == 0)
                {
                    return new
                    {
                        ok = true,
                        assistant_message = lastAssistantMessage,
                        rounds
                    };
                }

                var actionPlanSignature = BuildActionPlanSignature(actions);
                if (!string.IsNullOrWhiteSpace(actionPlanSignature))
                {
                    if (string.Equals(lastPlanSignature, actionPlanSignature, StringComparison.Ordinal))
                        repeatedPlanCount++;
                    else
                    {
                        lastPlanSignature = actionPlanSignature;
                        repeatedPlanCount = 1;
                    }

                    if (repeatedPlanCount >= 3 &&
                        (ToolResultsAllFailed(toolResults) || ToolResultsAllSucceeded(toolResults)))
                    {
                        return new
                        {
                            ok = false,
                            error = ToolResultsAllFailed(toolResults)
                                ? "Stopped repeated failing batch action loop."
                                : "Stopped repeated successful batch action loop without advancing.",
                            assistant_message = lastAssistantMessage,
                            rounds
                        };
                    }
                }
                else
                {
                    lastPlanSignature = "";
                    repeatedPlanCount = 0;
                }

                var nextToolResults = new System.Collections.Generic.List<OperatorToolResult>();
                foreach (var plannedAction in actions)
                {
                    var startedAt = DateTime.UtcNow;
                    try
                    {
                        var result = await ExecuteActionAsync(plannedAction, cancellationToken).ConfigureAwait(false);
                        nextToolResults.Add(await BuildToolResultAsync(plannedAction, startedAt, result, null).ConfigureAwait(false));
                    }
                    catch (Exception ex)
                    {
                        nextToolResults.Add(await BuildToolResultAsync(plannedAction, startedAt, null, ex).ConfigureAwait(false));
                    }
                }

                toolResults = nextToolResults;
                userText = "";
            }

            return new
            {
                ok = false,
                error = $"Stopped after max batch rounds ({perItemMaxRounds}).",
                assistant_message = lastAssistantMessage,
                rounds
            };
        }

        private static JsonObject ParseJsonObjectBestEffort(string? json)
        {
            try
            {
                var node = JsonNode.Parse(string.IsNullOrWhiteSpace(json) ? "{}" : json);
                if (node is JsonObject o) return o;
            }
            catch
            {
                // ignore
            }
            return new JsonObject();
        }

        private static JsonObject GetJsonObject(JsonObject root, string name)
        {
            try
            {
                if (root.TryGetPropertyValue(name, out var node) && node is JsonObject o) return o;
            }
            catch
            {
                // ignore
            }
            return new JsonObject();
        }

        private static string GetJsonString(JsonObject root, string name, int maxLen)
        {
            try
            {
                if (root.TryGetPropertyValue(name, out var node) && node is JsonValue value && value.TryGetValue<string>(out var text))
                {
                    var trimmed = (text ?? "").Trim();
                    if (trimmed.Length <= maxLen) return trimmed;
                    return trimmed.Substring(0, maxLen).Trim();
                }
            }
            catch
            {
                // ignore
            }
            return "";
        }

        private static int GetJsonInt(JsonObject root, string name, int fallback, int min, int max)
        {
            try
            {
                if (root.TryGetPropertyValue(name, out var node) && node is JsonValue value)
                {
                    if (value.TryGetValue<int>(out var asInt)) return Math.Max(min, Math.Min(max, asInt));
                    if (value.TryGetValue<long>(out var asLong)) return Math.Max(min, Math.Min(max, (int)Math.Max(int.MinValue, Math.Min(int.MaxValue, asLong))));
                    if (value.TryGetValue<string>(out var asString) && int.TryParse((asString ?? "").Trim(), out var parsed))
                        return Math.Max(min, Math.Min(max, parsed));
                }
            }
            catch
            {
                // ignore
            }
            return fallback;
        }

        private static bool? GetJsonBool(JsonObject root, string name)
        {
            try
            {
                if (root.TryGetPropertyValue(name, out var node) && node is JsonValue value)
                {
                    if (value.TryGetValue<bool>(out var asBool)) return asBool;
                    if (value.TryGetValue<string>(out var asString))
                    {
                        if (bool.TryParse((asString ?? "").Trim(), out var parsed)) return parsed;
                    }
                }
            }
            catch
            {
                // ignore
            }
            return null;
        }

        private static object? JsonNodeToObject(JsonNode? node)
        {
            try
            {
                if (node == null) return null;
                return JsonSerializer.Deserialize<object>(node.ToJsonString(), OperatorUiProtocol.JsonOptions);
            }
            catch
            {
                return null;
            }
        }

        private static System.Collections.Generic.List<string> GetJsonStringArray(JsonObject root, string name, int maxCount)
        {
            var values = new System.Collections.Generic.List<string>();
            try
            {
                if (root.TryGetPropertyValue(name, out var node) && node is JsonArray arr)
                {
                    foreach (var item in arr)
                    {
                        if (item is JsonValue value && value.TryGetValue<string>(out var text))
                        {
                            var trimmed = (text ?? "").Trim();
                            if (trimmed.Length == 0) continue;
                            values.Add(trimmed);
                            if (values.Count >= maxCount) break;
                        }
                    }
                }
            }
            catch
            {
                // ignore
            }
            return values;
        }

        private static int GetJsonSummaryTotal(JsonObject job)
        {
            try
            {
                var summary = GetJsonObject(job, "item_summary");
                return GetJsonInt(summary, "total", 0, 0, 100000);
            }
            catch
            {
                return 0;
            }
        }

        private static OperatorToolHostOpenRequest ParseToolHostOpenRequest(object? body)
        {
            if (body == null) throw new InvalidOperationException("ui.open requires a body.");

            if (body is JsonElement je)
            {
                return JsonSerializer.Deserialize<OperatorToolHostOpenRequest>(je.GetRawText(), OperatorUiProtocol.JsonOptions)
                    ?? new OperatorToolHostOpenRequest();
            }

            return JsonSerializer.Deserialize<OperatorToolHostOpenRequest>(
                       JsonSerializer.Serialize(body, OperatorUiProtocol.JsonOptions),
                       OperatorUiProtocol.JsonOptions)
                   ?? new OperatorToolHostOpenRequest();
        }

        private Uri ResolveToolHostUri(string raw)
        {
            var trimmed = (raw ?? "").Trim();
            if (trimmed.Length == 0) throw new InvalidOperationException("ui.open requires body.url.");

            if (Uri.TryCreate(trimmed, UriKind.Absolute, out var absolute))
            {
                if (!IsAllowedToolHostUri(absolute))
                    throw new InvalidOperationException("Tool UI origin is not allowed.");
                return absolute;
            }

            if (!Uri.TryCreate(_backendBaseUri, trimmed, out var relative))
                throw new InvalidOperationException("Tool UI URL is invalid.");
            if (!IsAllowedToolHostUri(relative))
                throw new InvalidOperationException("Tool UI origin is not allowed.");
            return relative;
        }

        private bool IsAllowedToolHostUri(Uri uri)
        {
            if (uri == null || !uri.IsAbsoluteUri) return false;
            if (!(string.Equals(uri.Scheme, Uri.UriSchemeHttp, StringComparison.OrdinalIgnoreCase) ||
                  string.Equals(uri.Scheme, Uri.UriSchemeHttps, StringComparison.OrdinalIgnoreCase)))
                return false;

            return IsSameToolHostOrigin(_backendBaseUri, uri);
        }

        private static bool IsSameToolHostOrigin(Uri expected, Uri actual)
        {
            if (expected == null || actual == null || !expected.IsAbsoluteUri || !actual.IsAbsoluteUri)
                return false;

            if (!string.Equals(expected.Scheme, actual.Scheme, StringComparison.OrdinalIgnoreCase))
                return false;
            if (expected.Port != actual.Port)
                return false;

            return string.Equals(expected.Host, actual.Host, StringComparison.OrdinalIgnoreCase) ||
                   (expected.IsLoopback && actual.IsLoopback);
        }

        private bool IsAllowedToolHostMessageSource(OperatorToolHostSession session, string? source)
        {
            if (string.IsNullOrWhiteSpace(source)) return false;
            if (!Uri.TryCreate(source, UriKind.Absolute, out var uri)) return false;
            return IsAllowedToolHostUri(uri) && IsSameToolHostOrigin(session.Url, uri);
        }

        private async Task<object> ExecuteUiOpenActionAsync(OperatorActionCall action, CancellationToken cancellationToken)
        {
            cancellationToken.ThrowIfCancellationRequested();
            var request = ParseToolHostOpenRequest(action.Body);
            var url = ResolveToolHostUri(request.Url);
            var session = new OperatorToolHostSession(request, url);

            if (string.Equals(session.Mode, "popup", StringComparison.OrdinalIgnoreCase))
                await OpenToolInPopupAsync(session, cancellationToken).ConfigureAwait(false);
            else
                await OpenToolInPaneAsync(session, cancellationToken).ConfigureAwait(false);

            _activeToolRequest = request;

            return new
            {
                ok = true,
                tool_host_id = session.Id,
                mode = session.Mode,
                title = session.Title,
                url = session.Url.ToString()
            };
        }

        private async Task<object> ExecuteUiCloseActionAsync(OperatorActionCall action)
        {
            string? target = null;
            try
            {
                if (action.Body is JsonElement je && je.ValueKind == JsonValueKind.Object)
                {
                    if (je.TryGetProperty("target", out var t) && t.ValueKind == JsonValueKind.String)
                        target = t.GetString();
                }
            }
            catch
            {
                target = null;
            }

            await CloseToolHostAsync(target).ConfigureAwait(false);
            return new { ok = true, target = string.IsNullOrWhiteSpace(target) ? "current" : target };
        }

        private async Task OpenToolInPaneAsync(OperatorToolHostSession session, CancellationToken cancellationToken)
        {
            cancellationToken.ThrowIfCancellationRequested();
            await CloseToolHostAsync("popup").ConfigureAwait(false);

            Ui(() =>
            {
                EnsureToolPane();
                _activeToolSession = session;
                if (_toolPaneTitle != null) _toolPaneTitle.Text = session.Title;
                try { _toolPaneWebView?.Dispose(); } catch { }
                _toolPaneWebView = new WebView2();
                if (_toolPaneBody != null) _toolPaneBody.Child = _toolPaneWebView;
                if (_toolPaneRoot != null) _toolPaneRoot.Visibility = Visibility.Visible;
                RefreshRootLayout();
            });

            var browser = _toolPaneWebView ?? throw new InvalidOperationException("Tool pane browser unavailable.");
            await ConfigureToolBrowserAsync(browser, session, cancellationToken).ConfigureAwait(false);
        }

        private async Task OpenToolInPopupAsync(OperatorToolHostSession session, CancellationToken cancellationToken)
        {
            cancellationToken.ThrowIfCancellationRequested();
            await CloseToolHostAsync("pane").ConfigureAwait(false);

            OperatorToolPopupWindow? popup = null;
            Ui(() =>
            {
                try { _toolPopupWindow?.Close(); } catch { }
                _activeToolSession = session;
                popup = new OperatorToolPopupWindow(session.Title, session.Width, session.Height, () =>
                {
                    if (_activeToolSession != null && _activeToolSession.Id == session.Id)
                    {
                        _activeToolSession = null;
                        _activeToolRequest = null;
                    }
                    _toolPopupWindow = null;
                });
                _toolPopupWindow = popup;
                popup.Show();
                popup.Activate();
            });

            var browser = popup?.Browser ?? throw new InvalidOperationException("Tool popup browser unavailable.");
            await ConfigureToolBrowserAsync(browser, session, cancellationToken).ConfigureAwait(false);
        }

        private async Task PopOutActiveToolAsync()
        {
            var request = _activeToolRequest;
            var session = _activeToolSession;
            if (request == null || session == null) return;

            var popupRequest = new OperatorToolHostOpenRequest
            {
                Url = request.Url,
                Mode = "popup",
                Title = request.Title,
                Width = request.Width,
                Height = request.Height,
                AllowedMessageTypes = request.AllowedMessageTypes,
                AllowedActions = request.AllowedActions,
                AllowedBackendPaths = request.AllowedBackendPaths,
                InitialPayload = request.InitialPayload.HasValue ? request.InitialPayload.Value.Clone() : (JsonElement?)null
            };

            await ExecuteUiOpenActionAsync(new OperatorActionCall
            {
                Method = "POST",
                Path = "/ui/open",
                Body = popupRequest
            }, CancellationToken.None).ConfigureAwait(false);
        }

        private async Task CloseToolHostAsync(string? target)
        {
            var normalized = (target ?? "").Trim().ToLowerInvariant();
            var closePane = normalized.Length == 0 || normalized == "current" || normalized == "pane";
            var closePopup = normalized.Length == 0 || normalized == "current" || normalized == "popup";
            var activeMode = (_activeToolSession?.Mode ?? "").Trim().ToLowerInvariant();
            var closesActiveSession = normalized.Length == 0 ||
                                      normalized == "current" ||
                                      (activeMode.Length > 0 && string.Equals(activeMode, normalized, StringComparison.OrdinalIgnoreCase));

            await Task.Yield();
            Ui(() =>
            {
                if (closePane)
                {
                    try { _toolPaneWebView?.Dispose(); } catch { }
                    _toolPaneWebView = null;
                    if (_toolPaneBody != null) _toolPaneBody.Child = null;
                    if (_toolPaneRoot != null) _toolPaneRoot.Visibility = Visibility.Collapsed;
                }

                if (closePopup)
                {
                    try { _toolPopupWindow?.Close(); } catch { }
                    _toolPopupWindow = null;
                }

                if (closesActiveSession)
                {
                    _activeToolSession = null;
                    _activeToolRequest = null;
                }

                RefreshRootLayout();
            });
        }

        private async Task ConfigureToolBrowserAsync(WebView2 browser, OperatorToolHostSession session, CancellationToken cancellationToken)
        {
            cancellationToken.ThrowIfCancellationRequested();
            await UiAsync(async () =>
            {
                var userDataFolder = Path.Combine(
                    Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                    "RevitOperator",
                    "WebView2",
                    "ToolHost");
                Directory.CreateDirectory(userDataFolder);

                browser.CreationProperties = new CoreWebView2CreationProperties
                {
                    UserDataFolder = userDataFolder
                };

                await browser.EnsureCoreWebView2Async();
                await browser.CoreWebView2.AddScriptToExecuteOnDocumentCreatedAsync(OperatorToolHostBridgeScript.Script);

                browser.CoreWebView2.Settings.AreDefaultContextMenusEnabled = true;
                browser.CoreWebView2.Settings.AreDevToolsEnabled = true;
                browser.CoreWebView2.Settings.AreBrowserAcceleratorKeysEnabled = true;
                browser.CoreWebView2.NavigationStarting += (_, e) =>
                {
                    try
                    {
                        if (!Uri.TryCreate(e.Uri, UriKind.Absolute, out var next) ||
                            !IsAllowedToolHostUri(next) ||
                            !IsSameToolHostOrigin(session.Url, next))
                        {
                            e.Cancel = true;
                        }
                    }
                    catch
                    {
                        e.Cancel = true;
                    }
                };
                browser.CoreWebView2.WebMessageReceived += (_, e) => _ = HandleToolHostMessageAsync(session, browser, e);
                browser.NavigationCompleted += (_, __) =>
                {
                    try
                    {
                        PostToolHostMessage(browser, new OperatorToolHostResponse
                        {
                            Id = "host.ready",
                            Type = "host.ready",
                            Ok = true,
                            Payload = session.ToInitPayload()
                        });
                    _ = LogToolHostAsync("toolhost.host_ready.posted", new
                    {
                        session_id = session.Id,
                        host_build = OperatorToolHostProtocol.BuildStamp,
                        mode = session.Mode,
                        title = session.Title,
                        url = session.Url.ToString()
                    });
                    }
                    catch
                    {
                        // ignore
                    }
                };

                browser.Source = session.Url;
                _ = LogToolHostAsync("toolhost.navigate", new
                {
                    session_id = session.Id,
                    host_build = OperatorToolHostProtocol.BuildStamp,
                    mode = session.Mode,
                    title = session.Title,
                    url = session.Url.ToString()
                });
            }).ConfigureAwait(false);
        }

        private static void PostToolHostMessage(WebView2 browser, OperatorToolHostResponse response)
        {
            if (browser?.CoreWebView2 == null) return;
            var json = JsonSerializer.Serialize(response, OperatorUiProtocol.JsonOptions);
            browser.CoreWebView2.PostWebMessageAsJson(json);
        }

        private Task PostToolHostMessageAsync(WebView2 browser, OperatorToolHostResponse response)
            => UiAsync(() =>
            {
                PostToolHostMessage(browser, response);
                return Task.CompletedTask;
            });

        private async Task LogToolHostAsync(string eventName, object data)
        {
            if (_logger == null) return;
            try
            {
                await _logger.LogAsync(eventName, data, CancellationToken.None).ConfigureAwait(false);
            }
            catch
            {
                // ignore tool-host diagnostics failures
            }
        }

        private async Task HandleToolHostMessageAsync(OperatorToolHostSession session, WebView2 browser, CoreWebView2WebMessageReceivedEventArgs args)
        {
            OperatorToolHostEnvelope? env = null;
            var source = "";
            try
            {
                source = args.Source ?? "";
                env = JsonSerializer.Deserialize<OperatorToolHostEnvelope>(args.WebMessageAsJson, OperatorUiProtocol.JsonOptions);
                if (env == null || !string.Equals(env.Version, OperatorToolHostProtocol.Version, StringComparison.Ordinal))
                    return;
            }
            catch
            {
                return;
            }

            await LogToolHostAsync("toolhost.message.received", new
            {
                session_id = session.Id,
                mode = session.Mode,
                message_id = env.Id,
                type = env.Type,
                source
            }).ConfigureAwait(false);

            if (!IsAllowedToolHostMessageSource(session, source))
            {
                await LogToolHostAsync("toolhost.message.rejected_source", new
                {
                    session_id = session.Id,
                    mode = session.Mode,
                    message_id = env.Id,
                    type = env.Type,
                    source
                }).ConfigureAwait(false);
                await PostToolHostMessageAsync(browser, new OperatorToolHostResponse
                {
                    Id = env.Id,
                    Type = env.Type + ".result",
                    Ok = false,
                    Error = "Tool UI message source is not allowed."
                }).ConfigureAwait(false);
                return;
            }

            if (!session.TryConsumeRequest())
            {
                await LogToolHostAsync("toolhost.message.rejected_rate_limit", new
                {
                    session_id = session.Id,
                    mode = session.Mode,
                    message_id = env.Id,
                    type = env.Type,
                    source
                }).ConfigureAwait(false);
                await PostToolHostMessageAsync(browser, new OperatorToolHostResponse
                {
                    Id = env.Id,
                    Type = env.Type + ".result",
                    Ok = false,
                    Error = "Tool UI request rate limit exceeded."
                }).ConfigureAwait(false);
                return;
            }

            if (!session.AllowsMessageType(env.Type))
            {
                await LogToolHostAsync("toolhost.message.rejected_type", new
                {
                    session_id = session.Id,
                    mode = session.Mode,
                    message_id = env.Id,
                    type = env.Type,
                    source
                }).ConfigureAwait(false);
                await PostToolHostMessageAsync(browser, new OperatorToolHostResponse
                {
                    Id = env.Id,
                    Type = env.Type + ".result",
                    Ok = false,
                    Error = "Tool UI message type is not allowed for this session."
                }).ConfigureAwait(false);
                return;
            }

            try
            {
                object? payload;
                await LogToolHostAsync("toolhost.message.dispatch_start", new
                {
                    session_id = session.Id,
                    mode = session.Mode,
                    message_id = env.Id,
                    type = env.Type,
                    source
                }).ConfigureAwait(false);
                switch ((env.Type ?? "").Trim())
                {
                    case "host.ping":
                        payload = new { sessionId = session.Id, title = session.Title, mode = session.Mode };
                        break;
                    case "host.getInitPayload":
                        payload = session.ToInitPayload();
                        break;
                    case "host.close":
                        await CloseToolHostAsync(session.Mode).ConfigureAwait(false);
                        payload = new { closed = true, mode = session.Mode };
                        break;
                    case "revit.ping":
                        payload = await _actionRunner.ExecuteAsync(new OperatorActionCall { Method = "GET", Path = "/revit/ping" }, CancellationToken.None).ConfigureAwait(false);
                        break;
                    case "revit.pickElements":
                        payload = await ExecuteToolPickElementsAsync(env.Payload).ConfigureAwait(false);
                        break;
                    case "revit.pickPoints":
                        payload = await ExecuteToolPickPointsAsync(env.Payload).ConfigureAwait(false);
                        break;
                    case "revit.showElements":
                        payload = await ExecuteToolShowElementsAsync(env.Payload).ConfigureAwait(false);
                        break;
                    case "revit.executeAction":
                        payload = await ExecuteToolHostedActionAsync(session, env.Payload).ConfigureAwait(false);
                        break;
                    case "backend.request":
                        payload = await ExecuteToolBackendRequestAsync(session, env.Payload).ConfigureAwait(false);
                        break;
                    default:
                        throw new InvalidOperationException("Unknown tool-host request type.");
                }

                await LogToolHostAsync("toolhost.message.payload_ready", new
                {
                    session_id = session.Id,
                    mode = session.Mode,
                    message_id = env.Id,
                    type = env.Type,
                    payload_type = payload?.GetType().FullName ?? "null"
                }).ConfigureAwait(false);
                await LogToolHostAsync("toolhost.message.post_start", new
                {
                    session_id = session.Id,
                    mode = session.Mode,
                    message_id = env.Id,
                    type = env.Type
                }).ConfigureAwait(false);
                await PostToolHostMessageAsync(browser, new OperatorToolHostResponse
                {
                    Id = env.Id,
                    Type = env.Type + ".result",
                    Ok = true,
                    Payload = payload
                }).ConfigureAwait(false);
                await LogToolHostAsync("toolhost.message.post_done", new
                {
                    session_id = session.Id,
                    mode = session.Mode,
                    message_id = env.Id,
                    type = env.Type
                }).ConfigureAwait(false);
                await LogToolHostAsync("toolhost.message.succeeded", new
                {
                    session_id = session.Id,
                    mode = session.Mode,
                    message_id = env.Id,
                    type = env.Type,
                    source
                }).ConfigureAwait(false);
            }
            catch (Exception ex)
            {
                await LogToolHostAsync("toolhost.message.failed", new
                {
                    session_id = session.Id,
                    mode = session.Mode,
                    message_id = env.Id,
                    type = env.Type,
                    source,
                    error = ex.Message,
                    detail = ex.ToString()
                }).ConfigureAwait(false);
                await PostToolHostMessageAsync(browser, new OperatorToolHostResponse
                {
                    Id = env.Id,
                    Type = env.Type + ".result",
                    Ok = false,
                    Error = FormatException(ex)
                }).ConfigureAwait(false);
            }
        }

        private async Task<object> ExecuteToolPickElementsAsync(JsonElement payload)
        {
            var prompt = payload.ValueKind == JsonValueKind.Object && payload.TryGetProperty("prompt", out var p) && p.ValueKind == JsonValueKind.String
                ? (p.GetString() ?? "Select elements and finish")
                : "Select elements and finish";

            return await _eventService.Run(app =>
            {
                var uidoc = app.ActiveUIDocument ?? throw new InvalidOperationException("No active Revit document.");
                var refs = uidoc.Selection.PickObjects(ObjectType.Element, prompt);
                var ids = refs.Select(r => r.ElementId.IntegerValue).ToArray();
                return (object)new { elementIds = ids };
            }).ConfigureAwait(false);
        }

        private async Task<object> ExecuteToolPickPointsAsync(JsonElement payload)
        {
            var count = 1;
            var prompt = "Pick point";
            if (payload.ValueKind == JsonValueKind.Object)
            {
                if (payload.TryGetProperty("count", out var c) && c.ValueKind == JsonValueKind.Number && c.TryGetInt32(out var parsed))
                    count = Math.Max(1, Math.Min(8, parsed));
                if (payload.TryGetProperty("prompt", out var p) && p.ValueKind == JsonValueKind.String)
                    prompt = p.GetString() ?? prompt;
            }

            return await _eventService.Run(app =>
            {
                var uidoc = app.ActiveUIDocument ?? throw new InvalidOperationException("No active Revit document.");
                var points = new List<object>();
                for (var i = 0; i < count; i++)
                {
                    var point = uidoc.Selection.PickPoint(prompt);
                    points.Add(new { x = point.X, y = point.Y, z = point.Z });
                }
                return (object)new { points };
            }).ConfigureAwait(false);
        }

        private async Task<object> ExecuteToolShowElementsAsync(JsonElement payload)
        {
            var ids = new List<int>();
            if (payload.ValueKind == JsonValueKind.Object)
            {
                if (payload.TryGetProperty("elementId", out var single) && single.ValueKind == JsonValueKind.Number && single.TryGetInt32(out var one))
                    ids.Add(one);
                if (payload.TryGetProperty("elementIds", out var many) && many.ValueKind == JsonValueKind.Array)
                {
                    foreach (var item in many.EnumerateArray())
                    {
                        if (item.ValueKind == JsonValueKind.Number && item.TryGetInt32(out var id)) ids.Add(id);
                    }
                }
            }

            if (ids.Count == 0) throw new InvalidOperationException("revit.showElements requires elementId or elementIds.");

            return await _eventService.Run(app =>
            {
                var uidoc = app.ActiveUIDocument ?? throw new InvalidOperationException("No active Revit document.");
                var elementIds = ids.Select(id => new Autodesk.Revit.DB.ElementId(id)).ToList();
                uidoc.ShowElements(elementIds);
                return (object)new { shown = elementIds.Count };
            }).ConfigureAwait(false);
        }

        private async Task<object> ExecuteToolHostedActionAsync(OperatorToolHostSession session, JsonElement payload)
        {
            if (payload.ValueKind != JsonValueKind.Object)
                throw new InvalidOperationException("revit.executeAction payload must be an object.");

            var method = payload.TryGetProperty("method", out var m) && m.ValueKind == JsonValueKind.String ? (m.GetString() ?? "") : "";
            var path = payload.TryGetProperty("path", out var p) && p.ValueKind == JsonValueKind.String ? (p.GetString() ?? "") : "";
            if (!session.AllowsAction(method, path))
                throw new InvalidOperationException("This hosted UI action is not allowed.");
            if (path.StartsWith("/ui/", StringComparison.OrdinalIgnoreCase))
                throw new InvalidOperationException("Hosted UI actions cannot recursively execute /ui/* actions.");

            object? body = null;
            if (payload.TryGetProperty("body", out var bodyEl))
                body = bodyEl.Clone();

            var risk = GetActionRisk(method, path, body);
            if (OperatorApprovalPolicy.RequiresApproval(_approvalMode, risk))
                throw new InvalidOperationException("This action requires approval. Switch Writes to Allow this session or YOLO in the Operator pane.");

            var action = new OperatorActionCall
            {
                ActionId = "toolhost:" + Guid.NewGuid().ToString("N"),
                Method = string.IsNullOrWhiteSpace(method) ? "POST" : method.Trim().ToUpperInvariant(),
                Path = path.Trim(),
                Body = body
            };

            return await ExecuteActionAsync(action, CancellationToken.None).ConfigureAwait(false);
        }

        private async Task<object> ExecuteToolBackendRequestAsync(OperatorToolHostSession session, JsonElement payload)
        {
            if (payload.ValueKind != JsonValueKind.Object)
                throw new InvalidOperationException("backend.request payload must be an object.");

            var method = payload.TryGetProperty("method", out var m) && m.ValueKind == JsonValueKind.String ? (m.GetString() ?? "GET") : "GET";
            var path = payload.TryGetProperty("path", out var p) && p.ValueKind == JsonValueKind.String ? (p.GetString() ?? "") : "";
            if (!session.AllowsBackendPath(path))
                throw new InvalidOperationException("This backend path is not allowed for the hosted UI.");

            var normalizedPath = path.Trim();
            if (!normalizedPath.StartsWith("/", StringComparison.Ordinal)) normalizedPath = "/" + normalizedPath;
            var uri = new Uri(_backendBaseUri, normalizedPath);

            object? body = null;
            if (payload.TryGetProperty("body", out var bodyEl))
                body = bodyEl.Clone();

            var json = await SendBackendToolRequestAsync(method, uri, body, CancellationToken.None).ConfigureAwait(false);
            if (string.IsNullOrWhiteSpace(json)) return new { ok = true };

            try
            {
                return JsonSerializer.Deserialize<object>(json, OperatorUiProtocol.JsonOptions) ?? new { ok = true };
            }
            catch
            {
                return new { raw = json };
            }
        }

        private async Task<string> SendBackendToolRequestAsync(string method, Uri uri, object? body, CancellationToken cancellationToken)
        {
            using var client = new HttpClient { Timeout = TimeSpan.FromMinutes(5) };
            using var request = new HttpRequestMessage(new HttpMethod((method ?? "GET").Trim().ToUpperInvariant()), uri);
            await ApplyBackendAuthHeadersAsync(request, forceRefresh: false, cancellationToken).ConfigureAwait(false);

            if (body != null)
            {
                var json = body is JsonElement je ? je.GetRawText() : JsonSerializer.Serialize(body, OperatorUiProtocol.JsonOptions);
                request.Content = new StringContent(json, Encoding.UTF8, "application/json");
            }

            using var response = await client.SendAsync(request, cancellationToken).ConfigureAwait(false);
            var text = await response.Content.ReadAsStringAsync().ConfigureAwait(false);
            if (!response.IsSuccessStatusCode)
                throw new InvalidOperationException(string.IsNullOrWhiteSpace(text) ? $"Backend request failed ({(int)response.StatusCode})." : text);
            return text;
        }

        private async Task ApplyBackendAuthHeadersAsync(HttpRequestMessage request, bool forceRefresh, CancellationToken cancellationToken)
        {
            await Task.CompletedTask.ConfigureAwait(false);
            request.Headers.TryAddWithoutValidation("X-Operator-Token", OperatorSecurity.GetOrCreateOperatorToken());

            var devToken = OperatorSecurity.GetDevAgentToken();
            if (!string.IsNullOrWhiteSpace(devToken))
                request.Headers.TryAddWithoutValidation("X-Operator-Dev-Agent-Token", devToken);
        }

        private object? RefreshContextForStep(object? existing)
        {
            try
            {
                OperatorWriteGrantStatus? writeGrantStatus = null;
                try
                {
                    writeGrantStatus = EnsureWriteGrantForApprovalMode(forceIssue: false);
                    Ui(() => PostWriteGrantStatusToUi(writeGrantStatus));
                }
                catch { writeGrantStatus = null; }

                var json = existing is JsonElement je ? je.GetRawText() : JsonSerializer.Serialize(existing, OperatorUiProtocol.JsonOptions);
                var root = (JsonNode.Parse(string.IsNullOrWhiteSpace(json) ? "{}" : json) as JsonObject) ?? new JsonObject();

                if (string.Equals(_brainRoute, "direct", StringComparison.Ordinal))
                    root["operator_brain_route"] = "direct";
                else
                    root.Remove("operator_brain_route");

                var ui = root["ui"] as JsonObject ?? new JsonObject();
                ui["approval_mode"] = UiModeString(_approvalMode);
                ui["reasoning_effort"] = NormalizeReasoningEffort(_reasoningEffort);
                ui["speed_settings"] = CloneJsonNode(_speedSettings);
                ui["native_api_policy"] = JsonNode.Parse(JsonSerializer.Serialize(OperatorNativeApiPolicy.GetStatus(), OperatorUiProtocol.JsonOptions));

                if (writeGrantStatus == null)
                {
                    ui["write_grant"] = null;
                }
                else
                {
                    ui["write_grant"] = JsonNode.Parse(JsonSerializer.Serialize(new
                    {
                        active = writeGrantStatus.Active,
                        mode = writeGrantStatus.Mode,
                        expires_at_utc = writeGrantStatus.ExpiresAtUtc?.ToString("o"),
                        uses_remaining = writeGrantStatus.UsesRemaining,
                        error = writeGrantStatus.Error
                    }, OperatorUiProtocol.JsonOptions));
                }

                root["ui"] = ui;

                // Return a JsonNode (not a JsonElement tied to a disposed JsonDocument).
                return root;
            }
            catch
            {
                return existing;
            }
        }

        private object? SpeedSettingsForContext()
        {
            try
            {
                var node = CloneJsonNode(_speedSettings);
                return node == null ? null : JsonNodeToObject(node);
            }
            catch
            {
                return null;
            }
        }

        private static JsonNode? CloneJsonNode(JsonNode? node)
        {
            try
            {
                return node == null ? null : JsonNode.Parse(node.ToJsonString());
            }
            catch
            {
                return null;
            }
        }

        private static string BuildActionPlanSignature(System.Collections.Generic.IReadOnlyList<OperatorActionCall> actions)
        {
            if (actions == null || actions.Count == 0) return "";

            var parts = new System.Collections.Generic.List<string>(actions.Count);
            foreach (var action in actions)
            {
                if (action == null)
                {
                    parts.Add("null");
                    continue;
                }

                var method = (action.Method ?? "").Trim().ToUpperInvariant();
                var path = (action.Path ?? "").Trim();
                var body = CanonicalizeActionBody(action.Body);
                parts.Add($"{method}|{path}|{body}");
            }
            return string.Join("\n", parts);
        }

        private static string CanonicalizeActionBody(object? body)
        {
            if (body == null) return "";
            try
            {
                if (body is JsonElement je)
                {
                    if (je.ValueKind == JsonValueKind.Null || je.ValueKind == JsonValueKind.Undefined) return "";
                    return je.GetRawText();
                }
                return JsonSerializer.Serialize(body, OperatorUiProtocol.JsonOptions);
            }
            catch
            {
                return "";
            }
        }

        private static bool ToolResultsAllFailed(System.Collections.Generic.List<OperatorToolResult>? toolResults)
        {
            if (toolResults == null || toolResults.Count == 0) return false;
            foreach (var tr in toolResults)
            {
                if (tr == null) continue;
                if (!string.Equals((tr.Status ?? "").Trim(), "failed", StringComparison.OrdinalIgnoreCase))
                {
                    return false;
                }
            }
            return true;
        }

        private static bool ToolResultsAllSucceeded(System.Collections.Generic.List<OperatorToolResult>? toolResults)
        {
            if (toolResults == null || toolResults.Count == 0) return false;
            foreach (var tr in toolResults)
            {
                if (tr == null) continue;
                if (!string.Equals((tr.Status ?? "").Trim(), "done", StringComparison.OrdinalIgnoreCase))
                {
                    return false;
                }
            }
            return true;
        }

        private static void FreezeActionBodiesInPlace(System.Collections.Generic.List<OperatorActionCall> actions)
        {
            if (actions == null || actions.Count == 0) return;

            for (int i = 0; i < actions.Count; i++)
            {
                var action = actions[i];
                if (action == null) continue;

                if (action.Body is JsonElement je)
                {
                    try
                    {
                        // Prevent "Cannot access a disposed object. Object name: 'JsonDocument'." when we later
                        // call JsonElement.GetRawText() (e.g., during tool execution or approval flows).
                        using var doc = JsonDocument.Parse(je.GetRawText());
                        action.Body = doc.RootElement.Clone();
                    }
                    catch
                    {
                        // best effort
                    }
                }
            }
        }

        private async Task TryPlanPendingActionAsync(string actionId, OperatorActionCall action)
        {
            try
            {
                if (string.IsNullOrWhiteSpace(actionId)) return;
                if (!_pendingApprovals.ContainsKey(actionId)) return;

                var path = (action.Path ?? "").Trim();
                if (string.IsNullOrWhiteSpace(path)) return;
                if (!string.Equals((action.Method ?? "").Trim(), "POST", StringComparison.OrdinalIgnoreCase)) return;

                // Only attempt planning for tools that support {dryRun:true} or legacy {apply:false}.
                var supportsDryRun =
                    string.Equals(path, "/revit/delete", StringComparison.OrdinalIgnoreCase) ||
                    string.Equals(path, "/revit/set-parameter", StringComparison.OrdinalIgnoreCase);

                if (!supportsDryRun) return;

                var bodyJson = "{}";
                if (action.Body is JsonElement je) bodyJson = je.ValueKind == JsonValueKind.Undefined ? "{}" : je.GetRawText();
                else if (action.Body != null) bodyJson = JsonSerializer.Serialize(action.Body, OperatorUiProtocol.JsonOptions);

                JsonObject node;
                try
                {
                    node = (JsonNode.Parse(bodyJson) as JsonObject) ?? new JsonObject();
                }
                catch
                {
                    node = new JsonObject();
                }

                node["dryRun"] = true;
                node["apply"] = false;
                if (node.ContainsKey("confirm")) node.Remove("confirm");

                using var plannedDoc = JsonDocument.Parse(node.ToJsonString());
                var planned = new OperatorActionCall
                {
                    ActionId = action.ActionId,
                    Method = action.Method,
                    Path = action.Path,
                    Body = plannedDoc.RootElement.Clone()
                };

                object? result = null;
                Exception? error = null;
                try
                {
                    result = await ExecuteActionAsync(planned, CancellationToken.None).ConfigureAwait(false);
                }
                catch (Exception ex)
                {
                    error = ex;
                }

                Ui(() => SetActionPlan(actionId, result, error == null ? null : FormatException(error)));
            }
            catch
            {
                // best effort
            }
        }

        private static bool IsBackendConnectionFailure(Exception ex)
        {
            Exception? cur = ex;
            for (int i = 0; i < 6 && cur != null; i++)
            {
                if (cur is HttpRequestException) return true;
                if (cur is SocketException) return true;
                cur = cur.InnerException;
            }

            var msg = ex.Message ?? "";
            return msg.IndexOf("actively refused", StringComparison.OrdinalIgnoreCase) >= 0 ||
                   msg.IndexOf("Unable to connect", StringComparison.OrdinalIgnoreCase) >= 0 ||
                   msg.IndexOf("No connection could be made", StringComparison.OrdinalIgnoreCase) >= 0;
        }

        private static bool IsCaptureLikePath(string? path)
        {
            if (string.IsNullOrWhiteSpace(path)) return false;
            var p = path.Trim();
            if (string.Equals(p, "/revit/export-image", StringComparison.OrdinalIgnoreCase)) return true;
            if (string.Equals(p, "/revit/export-view-frame", StringComparison.OrdinalIgnoreCase)) return true;
            if (string.Equals(p, "/revit/export-view-region", StringComparison.OrdinalIgnoreCase)) return true;
            if (string.Equals(p, "/revit/export-visible-elements", StringComparison.OrdinalIgnoreCase)) return true;
            if (string.Equals(p, "/revit/highlight-and-export", StringComparison.OrdinalIgnoreCase)) return true;
            if (string.Equals(p, "/revit/capture-screenshare", StringComparison.OrdinalIgnoreCase)) return true;
            if (string.Equals(p, "/revit/capture-sheet-region", StringComparison.OrdinalIgnoreCase)) return true;
            if (string.Equals(p, "/revit/verify-parameter-on-sheet", StringComparison.OrdinalIgnoreCase)) return true;
            return false;
        }

        private static bool TryGetTitleblockSheetIdsFromSetParameterResult(object? result, out System.Collections.Generic.List<long> sheetViewIds)
        {
            sheetViewIds = new System.Collections.Generic.List<long>();
            try
            {
                if (result == null) return false;
                var json = result is JsonElement je ? je.GetRawText() : JsonSerializer.Serialize(result, OperatorUiProtocol.JsonOptions);
                using var doc = JsonDocument.Parse(json);
                var root = doc.RootElement;
                if (!root.TryGetProperty("dryRun", out var dr) || (dr.ValueKind == JsonValueKind.True && dr.GetBoolean())) return false;
                if (!root.TryGetProperty("titleblockImpacts", out var arr) || arr.ValueKind != JsonValueKind.Array) return false;

                foreach (var item in arr.EnumerateArray())
                {
                    if (item.ValueKind != JsonValueKind.Object) continue;
                    if (!item.TryGetProperty("sheetViewId", out var sid) || sid.ValueKind != JsonValueKind.Number) continue;
                    if (!sid.TryGetInt64(out var v) || v <= 0) continue;
                    if (!sheetViewIds.Contains(v)) sheetViewIds.Add(v);
                }

                return sheetViewIds.Count > 0;
            }
            catch
            {
                sheetViewIds = new System.Collections.Generic.List<long>();
                return false;
            }
        }

        private async Task TryRunDeferredVerificationAsync(OperatorTurnState turn, string assistantMessageId, System.Collections.Generic.List<OperatorToolResult> toolResultsSink)
        {
            try
            {
                if (turn == null) return;
                if (turn.DeferredActions.Count == 0) return;

                if (turn.WriteAppliedInStep)
                {
                    try
                    {
                        var regen = new OperatorActionCall
                        {
                            ActionId = $"{assistantMessageId}:__regen_before_verify",
                            Method = "POST",
                            Path = "/revit/regenerate",
                            Body = new { refreshActiveView = true }
                        };
                        var startedAt = DateTime.UtcNow;
                        object? regenResult = null;
                        Exception? regenErr = null;
                        try { regenResult = await ExecuteActionAsync(regen, CancellationToken.None).ConfigureAwait(false); }
                        catch (Exception ex) { regenErr = ex; }
                        toolResultsSink.Add(await BuildToolResultAsync(regen, startedAt, regenResult, regenErr).ConfigureAwait(false));
                    }
                    catch
                    {
                        // ignore regen failures; verification may still succeed
                    }
                }

                // Execute deferred capture/verify actions in-order.
                var list = new System.Collections.Generic.List<OperatorActionCall>(turn.DeferredActions);
                turn.DeferredActions.Clear();
                foreach (var action in list)
                {
                    if (action == null) continue;
                    var actionId = action.ActionId ?? "";
                    var startedAt = DateTime.UtcNow;
                    try
                    {
                        Ui(() => UpdateActionStatus(actionId, "running", null));
                        var result = await ExecuteActionAsync(action, CancellationToken.None).ConfigureAwait(false);
                        Ui(() => SetActionResult(actionId, result));
                        Ui(() => UpdateActionStatus(actionId, "done", null));
                        toolResultsSink.Add(await BuildToolResultAsync(action, startedAt, result, null).ConfigureAwait(false));
                    }
                    catch (Exception ex)
                    {
                        var err = FormatException(ex);
                        Ui(() => UpdateActionStatus(actionId, "failed", err));
                        toolResultsSink.Add(await BuildToolResultAsync(action, startedAt, result: null, ex).ConfigureAwait(false));
                    }
                }
            }
            catch
            {
                // best effort
            }
        }

        private async Task CancelActiveTurnAsync(string stopReason)
        {
            var turn = _activeTurn;
            if (turn == null) return;

            try
            {
                // Best-effort: cancel in-flight backend calls. Revit API calls on the main thread cannot always be aborted mid-flight.
                try { _activeTurnCts?.Cancel(); } catch { }

                // If the loop isn't actively running (e.g., awaiting approvals), clear local state immediately.
                if (!_turnBusy)
                {
                    _pendingApprovals.Clear();
                    _turnByApprovalActionId.Clear();
                    _activeTurn = null;
                    try { _activeTurnCts?.Dispose(); } catch { }
                    _activeTurnCts = null;
                    Ui(() => { if (_webView?.CoreWebView2 != null) PostToUi("loop.state", new { running = false }); });
                    Ui(() => AppendChat("system", "Cancelled.", null));
                }
                else
                {
                    Ui(() => AppendChat("system", "Stop requested. Finishing the current non-interruptible Revit action, then the run will stop.", null));
                }

                var msgId = $"{turn.RootMessageId}:assistant:{Math.Max(1, turn.Step)}";
                try { await _backendClient.NotifyLoopStopAsync(turn.SessionId, msgId, stopReason, CancellationToken.None).ConfigureAwait(false); } catch { }
            }
            catch
            {
                // ignore
            }
        }

        private async Task<OperatorToolResult> BuildToolResultAsync(OperatorActionCall action, DateTime startedAtUtc, object? result, Exception? error)
        {
            var finishedAtUtc = DateTime.UtcNow;
            var durationMs = (finishedAtUtc - startedAtUtc).TotalMilliseconds;
            var bodyJson = GetActionBodyJson(action.Body);

            var tr = new OperatorToolResult
            {
                ActionId = action.ActionId ?? "",
                Method = (action.Method ?? "").Trim().ToUpperInvariant(),
                Path = (action.Path ?? "").Trim(),
                RequestEffect = OperatorApprovalPolicy.GetEffectWireValue(action.Method, action.Path, bodyJson),
                Status = error == null ? "done" : "failed",
                ResultJson = error is OperatorRecoveredDialogException recovered ? recovered.Receipt : (error == null ? result : null),
                Error = error == null ? null : FormatException(error),
                FailureKind = error is OperatorRecoveredDialogException ? "runtime_recovery" : null,
                FailureCode = error is OperatorRecoveredDialogException ? "retryable_revit_dialog_recovered" : null,
                DurationMs = durationMs
            };

            try
            {
                if (error == null)
                {
                    if (string.Equals(tr.Path, "/revit/export-pdf", StringComparison.OrdinalIgnoreCase))
                    {
                        var augmented = await TryAugmentExportPdfResultForBackendAsync(result).ConfigureAwait(false);
                        if (augmented != null)
                        {
                            tr.ResultJson = augmented;
                            result = augmented;
                        }
                    }

                    var imagePath = TryFindImagePath(result);
                    if (!string.IsNullOrWhiteSpace(imagePath) && File.Exists(imagePath))
                    {
                        if (TryBuildImageAttachment(imagePath!, maxBytes: 2_500_000, out var att))
                        {
                            tr.Attachments = new System.Collections.Generic.List<OperatorToolAttachment> { att };
                        }
                        else
                        {
                            tr.Attachments = new System.Collections.Generic.List<OperatorToolAttachment>
                            {
                                new OperatorToolAttachment
                                {
                                    Kind = "image",
                                    Mime = "image/jpeg",
                                    Filename = Path.GetFileName(imagePath),
                                    LocalPath = imagePath
                                }
                            };
                        }
                    }
                }
            }
            catch
            {
                // best effort
            }

            return tr;
        }

        private static OperatorActionRisk GetActionRisk(OperatorActionCall action)
        {
            if (action == null) return OperatorActionRisk.High;
            return GetActionRisk(action.Method, action.Path, action.Body);
        }

        private static OperatorActionRisk GetActionRisk(string method, string path, object? body)
        {
            return OperatorApprovalPolicy.GetRisk(method, path, GetActionBodyJson(body));
        }

        private static string? GetActionBodyJson(object? body)
        {
            if (body == null) return null;
            try
            {
                if (body is JsonElement element)
                {
                    return element.ValueKind == JsonValueKind.Undefined ? null : element.GetRawText();
                }

                return JsonSerializer.Serialize(body, OperatorUiProtocol.JsonOptions);
            }
            catch
            {
                // Malformed/unserializable action bodies must never downgrade a path's base risk.
                return null;
            }
        }

        private async Task<object?> TryAugmentExportPdfResultForBackendAsync(object? result)
        {
            try
            {
                var localPaths = ExtractExportPdfOutputPaths(result);
                if (localPaths.Count == 0) return result;

                var uploadItems = new System.Collections.Generic.List<OperatorUserAttachment>();
                var uploadLocalPaths = new System.Collections.Generic.List<string>();

                foreach (var local in localPaths.Distinct(StringComparer.OrdinalIgnoreCase))
                {
                    if (string.IsNullOrWhiteSpace(local)) continue;
                    var full = local;
                    try
                    {
                        full = Path.IsPathRooted(local)
                            ? Path.GetFullPath(local)
                            : WorkspacePaths.ResolveFileUnderWorkspace(local);
                    }
                    catch { }
                    if (!File.Exists(full)) continue;

                    var rel = TryToWorkspaceRelativePath(full);
                    if (string.IsNullOrWhiteSpace(rel)) continue;
                    if (!string.Equals(Path.GetExtension(rel), ".pdf", StringComparison.OrdinalIgnoreCase)) continue;

                    var fi = new FileInfo(full);
                    if (!fi.Exists || fi.Length <= 0) continue;

                    uploadItems.Add(new OperatorUserAttachment
                    {
                        Id = Guid.NewGuid().ToString("N"),
                        RelativePath = rel,
                        Filename = Path.GetFileName(full),
                        Bytes = fi.Length,
                        Mime = "application/pdf",
                        CreatedAt = DateTime.UtcNow.ToString("o")
                    });
                    uploadLocalPaths.Add(full);
                }

                if (uploadItems.Count == 0) return result;

                System.Collections.Generic.List<OperatorUserAttachment> uploaded;
                try
                {
                    var uploadSessionId = await EnsureSessionAsync().ConfigureAwait(false);
                    uploaded = await _backendClient.UploadUserAttachmentsAsync(uploadItems, uploadSessionId, CancellationToken.None).ConfigureAwait(false);
                }
                catch (Exception ex)
                {
                    var warnNode = ToJsonObjectBestEffort(result);
                    warnNode["backend_upload_warning"] = "export-pdf auto-upload failed: " + ex.Message;
                    return warnNode;
                }

                var root = ToJsonObjectBestEffort(result);
                var backendPaths = new JsonArray();
                var mapping = new JsonArray();

                var count = Math.Min(uploadLocalPaths.Count, uploaded.Count);
                for (int i = 0; i < count; i++)
                {
                    var up = uploaded[i];
                    if (up == null) continue;
                    var rel = (up.RelativePath ?? "").Trim().Replace("\\", "/");
                    if (string.IsNullOrWhiteSpace(rel)) continue;

                    backendPaths.Add(rel);
                    mapping.Add(new JsonObject
                    {
                        ["local_path"] = uploadLocalPaths[i],
                        ["backend_relative_path"] = rel,
                        ["filename"] = string.IsNullOrWhiteSpace(up.Filename) ? Path.GetFileName(uploadLocalPaths[i]) : up.Filename
                    });
                }

                if (backendPaths.Count == 0)
                {
                    root["backend_upload_warning"] = "export-pdf auto-upload returned no backend-relative paths.";
                    return root;
                }

                if (backendPaths.Count == 1 && backendPaths[0] is JsonValue jv && jv.TryGetValue<string>(out var one) && !string.IsNullOrWhiteSpace(one))
                {
                    root["backend_path"] = one;
                }

                root["backend_paths"] = backendPaths;
                root["backend_uploaded_artifacts"] = new JsonObject
                {
                    ["kind"] = "export_pdf",
                    ["count"] = backendPaths.Count,
                    ["files"] = mapping
                };

                return root;
            }
            catch
            {
                return result;
            }
        }

        private static JsonObject ToJsonObjectBestEffort(object? obj)
        {
            try
            {
                var json = obj is JsonElement je ? je.GetRawText() : JsonSerializer.Serialize(obj, OperatorUiProtocol.JsonOptions);
                var node = JsonNode.Parse(string.IsNullOrWhiteSpace(json) ? "{}" : json);
                if (node is JsonObject o) return o;
            }
            catch
            {
                // ignore
            }
            return new JsonObject();
        }

        private static System.Collections.Generic.List<string> ExtractExportPdfOutputPaths(object? result)
        {
            var outPaths = new System.Collections.Generic.List<string>();
            try
            {
                if (result == null) return outPaths;
                var json = result is JsonElement je ? je.GetRawText() : JsonSerializer.Serialize(result, OperatorUiProtocol.JsonOptions);
                using var doc = JsonDocument.Parse(string.IsNullOrWhiteSpace(json) ? "{}" : json);
                var root = doc.RootElement;
                if (root.ValueKind != JsonValueKind.Object) return outPaths;

                if ((root.TryGetProperty("dryRun", out var dr) && dr.ValueKind == JsonValueKind.True) ||
                    (root.TryGetProperty("dry_run", out var dr2) && dr2.ValueKind == JsonValueKind.True))
                {
                    return outPaths;
                }

                if (root.TryGetProperty("path", out var p) && p.ValueKind == JsonValueKind.String)
                {
                    var s = p.GetString();
                    if (!string.IsNullOrWhiteSpace(s)) outPaths.Add(s.Trim());
                }

                if (root.TryGetProperty("paths", out var arr) && arr.ValueKind == JsonValueKind.Array)
                {
                    foreach (var item in arr.EnumerateArray())
                    {
                        if (item.ValueKind != JsonValueKind.String) continue;
                        var s = item.GetString();
                        if (!string.IsNullOrWhiteSpace(s)) outPaths.Add(s.Trim());
                    }
                }
            }
            catch
            {
                // ignore
            }
            return outPaths;
        }

        private static string? TryToWorkspaceRelativePath(string fullPath)
        {
            try
            {
                if (string.IsNullOrWhiteSpace(fullPath)) return null;
                var root = Path.GetFullPath(WorkspacePaths.GetWorkspaceRoot())
                    .TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
                var full = Path.GetFullPath(fullPath)
                    .TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);

                var prefix = root + Path.DirectorySeparatorChar;
                if (string.Equals(full, root, StringComparison.OrdinalIgnoreCase)) return null;
                if (!full.StartsWith(prefix, StringComparison.OrdinalIgnoreCase)) return null;

                var rel = full.Substring(prefix.Length).Replace("\\", "/");
                return string.IsNullOrWhiteSpace(rel) ? null : rel;
            }
            catch
            {
                return null;
            }
        }

        private static bool TryBuildImageAttachment(string imagePath, int maxBytes, out OperatorToolAttachment attachment)
        {
            attachment = new OperatorToolAttachment
            {
                Kind = "image",
                Mime = "image/jpeg",
                Filename = Path.GetFileName(imagePath),
                LocalPath = imagePath
            };

            try
            {
                var fi = new FileInfo(imagePath);
                if (!fi.Exists || fi.Length <= 0) return false;

                // Fast path: embed as-is if already small enough and we know the mime.
                var ext = (Path.GetExtension(imagePath) ?? "").ToLowerInvariant();
                if (fi.Length <= maxBytes && (ext == ".jpg" || ext == ".jpeg" || ext == ".png"))
                {
                    var bytes = ReadAllBytesShared(imagePath);
                    if (bytes.Length <= maxBytes)
                    {
                        attachment.Mime = ext == ".png" ? "image/png" : "image/jpeg";
                        attachment.DataBase64 = Convert.ToBase64String(bytes);
                        return true;
                    }
                }

                // Otherwise, re-encode to JPEG within size limits so the backend can forward the image to OpenAI.
                if (TryReencodeJpegWithinLimit(imagePath, maxBytes, out var jpegBytes))
                {
                    attachment.Mime = "image/jpeg";
                    attachment.DataBase64 = Convert.ToBase64String(jpegBytes);
                    return true;
                }
            }
            catch
            {
                // ignore
            }

            return false;
        }

        private static byte[] ReadAllBytesShared(string path)
        {
            using var fs = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite);
            using var ms = new MemoryStream();
            fs.CopyTo(ms);
            return ms.ToArray();
        }

        private static bool TryReencodeJpegWithinLimit(string imagePath, int maxBytes, out byte[] jpegBytes)
        {
            jpegBytes = Array.Empty<byte>();

            BitmapSource? source = null;
            try
            {
                using var fs = new FileStream(imagePath, FileMode.Open, FileAccess.Read, FileShare.ReadWrite);
                var frame = BitmapFrame.Create(fs, BitmapCreateOptions.None, BitmapCacheOption.OnLoad);
                source = frame;
            }
            catch
            {
                return false;
            }

            if (source == null) return false;

            var w = source.PixelWidth;
            var h = source.PixelHeight;
            if (w <= 0 || h <= 0) return false;

            var maxDims = new[] { 2200, 1800, 1400, 1100, 900 };
            var qualities = new[] { 85, 75, 65, 55, 45 };

            foreach (var maxDim in maxDims)
            {
                var scale = 1.0;
                var curMax = Math.Max(w, h);
                if (curMax > maxDim) scale = (double)maxDim / curMax;

                BitmapSource scaled = source;
                if (scale < 0.999)
                {
                    scaled = new TransformedBitmap(source, new ScaleTransform(scale, scale));
                    scaled.Freeze();
                }

                foreach (var q in qualities)
                {
                    using var ms = new MemoryStream();
                    var enc = new JpegBitmapEncoder { QualityLevel = q };
                    enc.Frames.Add(BitmapFrame.Create(scaled));
                    enc.Save(ms);
                    var bytes = ms.ToArray();
                    if (bytes.Length > 0 && bytes.Length <= maxBytes)
                    {
                        jpegBytes = bytes;
                        return true;
                    }
                }
            }

            return false;
        }

        private static string? TryFindImagePath(object? result)
        {
            try
            {
                if (result == null) return null;

                // Common fast paths.
                var p = TryExtractStringProperty(result, "path");
                if (LooksLikeImagePath(p) && File.Exists(p!)) return p;

                var pp = TryExtractNestedStringProperty(result, "preview", "path");
                if (LooksLikeImagePath(pp) && File.Exists(pp!)) return pp;

                // Fallback: search any string leaf that looks like an image path.
                if (result is JsonElement je)
                {
                    return FindImagePathInJson(je);
                }

                var json = JsonSerializer.Serialize(result, OperatorUiProtocol.JsonOptions);
                using var doc = JsonDocument.Parse(json);
                return FindImagePathInJson(doc.RootElement);
            }
            catch
            {
                return null;
            }
        }

        private static string? FindImagePathInJson(JsonElement el)
        {
            try
            {
                if (el.ValueKind == JsonValueKind.Object)
                {
                    foreach (var p in el.EnumerateObject())
                    {
                        if (p.Value.ValueKind == JsonValueKind.String)
                        {
                            var s = p.Value.GetString();
                            if (LooksLikeImagePath(s) && File.Exists(s!)) return s;
                        }

                        var nested = FindImagePathInJson(p.Value);
                        if (!string.IsNullOrWhiteSpace(nested)) return nested;
                    }
                }

                if (el.ValueKind == JsonValueKind.Array)
                {
                    foreach (var item in el.EnumerateArray())
                    {
                        var nested = FindImagePathInJson(item);
                        if (!string.IsNullOrWhiteSpace(nested)) return nested;
                    }
                }
            }
            catch
            {
                // ignore
            }

            return null;
        }

        private static bool LooksLikeImagePath(string? path)
        {
            if (string.IsNullOrWhiteSpace(path)) return false;
            var ext = (Path.GetExtension(path) ?? "").ToLowerInvariant();
            return ext == ".jpg" || ext == ".jpeg" || ext == ".png";
        }

        private static string? TryExtractNestedStringProperty(object? obj, string objectPropertyName, string leafPropertyName)
        {
            try
            {
                if (obj == null) return null;
                if (obj is JsonElement je && je.ValueKind == JsonValueKind.Object)
                {
                    if (!je.TryGetProperty(objectPropertyName, out var o) || o.ValueKind != JsonValueKind.Object) return null;
                    if (o.TryGetProperty(leafPropertyName, out var p) && p.ValueKind == JsonValueKind.String) return p.GetString();
                    return null;
                }

                var json = JsonSerializer.Serialize(obj, OperatorUiProtocol.JsonOptions);
                using var doc = JsonDocument.Parse(json);
                if (doc.RootElement.ValueKind != JsonValueKind.Object) return null;
                if (!doc.RootElement.TryGetProperty(objectPropertyName, out var oo) || oo.ValueKind != JsonValueKind.Object) return null;
                if (oo.TryGetProperty(leafPropertyName, out var pp) && pp.ValueKind == JsonValueKind.String) return pp.GetString();
            }
            catch { }
            return null;
        }

        private static string? TryExtractStringProperty(object? obj, string propertyName)
        {
            try
            {
                if (obj == null) return null;
                if (obj is JsonElement je && je.ValueKind == JsonValueKind.Object)
                {
                    if (je.TryGetProperty(propertyName, out var p) && p.ValueKind == JsonValueKind.String) return p.GetString();
                    return null;
                }

                var json = JsonSerializer.Serialize(obj, OperatorUiProtocol.JsonOptions);
                using var doc = JsonDocument.Parse(json);
                if (doc.RootElement.ValueKind == JsonValueKind.Object)
                {
                    if (doc.RootElement.TryGetProperty(propertyName, out var p) && p.ValueKind == JsonValueKind.String) return p.GetString();
                }
            }
            catch { }
            return null;
        }

        private async Task EnsureBackendRunningAsync(CancellationToken cancellationToken)
        {
            // Always kick the watchdog (cheap/no-op if already started).
            OperatorBackendAutoStart.TryStartInBackground();

            if (await OperatorBackendHealth.IsHealthyWithRetriesAsync(
                    _backendBaseUri,
                    attempts: 3,
                    timeoutMs: 1200,
                    delayMs: 250,
                    cancellationToken: cancellationToken).ConfigureAwait(false))
            {
                StartProactivityIfNeeded();
                return;
            }

            // Backend can die mid-flight; EnsureHealthyAsync can restart even if it was previously started.
            if (await OperatorBackendAutoStart.EnsureHealthyAsync(_backendBaseUri, cancellationToken).ConfigureAwait(false))
            {
                StartProactivityIfNeeded();
                return;
            }

            // Final short retry window for transient remote/auth-gated backends before surfacing an error.
            if (await OperatorBackendHealth.IsHealthyWithRetriesAsync(
                    _backendBaseUri,
                    attempts: 3,
                    timeoutMs: 1500,
                    delayMs: 350,
                    cancellationToken: cancellationToken).ConfigureAwait(false))
            {
                StartProactivityIfNeeded();
                return;
            }

            throw new Exception($"Backend not reachable at {_backendBaseUri} (health check failed).");
        }

        private static string FormatException(Exception ex)
        {
            try
            {
                var cur = ex;
                var parts = new System.Collections.Generic.List<string>();
                for (int i = 0; i < 4 && cur != null; i++)
                {
                    parts.Add(cur.Message);
                    cur = cur.InnerException;
                }
                return string.Join(" | ", parts);
            }
            catch
            {
                return ex.Message;
            }
        }

        private async Task<string> EnsureSessionAsync()
        {
            if (!string.IsNullOrWhiteSpace(_sessionId)) return _sessionId!;
            var sid = await _backendClient.CreateSessionAsync(CancellationToken.None).ConfigureAwait(false);
            _sessionId = sid;
            _proactivity?.OnSessionChanged(sid);
            return sid;
        }

        private void Ui(Action action)
        {
            if (Dispatcher.CheckAccess()) action();
            else Dispatcher.Invoke(action);
        }

        private async Task UiAsync(Func<Task> action)
        {
            if (Dispatcher.CheckAccess())
            {
                await action().ConfigureAwait(false);
                return;
            }

            await Dispatcher.InvokeAsync(action).Task.Unwrap().ConfigureAwait(false);
        }

        private void AppendChat(string role, string text, string? messageId = null)
        {
            if (_webView?.CoreWebView2 != null)
            {
                PostToUi("chat.append", new { role, text, messageId });
            }
            else
            {
                _fallback?.AppendChat(role, text);
            }
        }

        private void AddAction(string actionId, string title, string path, object? body)
        {
            if (_webView?.CoreWebView2 != null)
            {
                PostToUi("action.add", new { actionId, title, path, body });
            }
            else
            {
                _fallback?.AddAction(actionId, title, path, body);
            }
        }

        private void AddAction(string actionId, string title, string path, object? body, bool approvalRequired, OperatorActionRisk risk)
        {
            if (_webView?.CoreWebView2 != null)
            {
                PostToUi("action.add", new { actionId, title, path, body, approvalRequired, risk = risk.ToString() });
            }
            else
            {
                _fallback?.AddAction(actionId, title, path, body);
            }
        }

        private void UpdateActionStatus(string actionId, string status, string? error)
        {
            if (_webView?.CoreWebView2 != null)
            {
                PostToUi("action.status", new { actionId, status, error });
            }
            else
            {
                _fallback?.UpdateActionStatus(actionId, status, error);
            }
        }

        private void SetActionResult(string actionId, object? resultJson)
        {
            if (_webView?.CoreWebView2 != null)
            {
                PostToUi("action.result", new { actionId, resultJson });
            }
            else
            {
                _fallback?.SetActionResult(actionId, resultJson);
            }
        }

        private void SetActionPlan(string actionId, object? planJson, string? error)
        {
            if (_webView?.CoreWebView2 != null)
            {
                PostToUi("action.plan", new { actionId, planJson, error });
            }
        }

        private void PostToUi(string type, object payload)
        {
            var msg = JsonSerializer.Serialize(new
            {
                version = OperatorUiProtocol.Version,
                type,
                payload
            }, OperatorUiProtocol.JsonOptions);

            _webView!.CoreWebView2.PostWebMessageAsJson(msg);
        }

        private static TimeSpan WriteGrantRefreshThreshold(OperatorApprovalMode mode)
        {
            return mode == OperatorApprovalMode.Yolo ? TimeSpan.FromMinutes(15) : TimeSpan.FromMinutes(2);
        }

        private OperatorWriteGrantStatus EnsureWriteGrantForApprovalMode(bool forceIssue)
        {
            if (_approvalMode == OperatorApprovalMode.Safe)
            {
                OperatorWriteGrant.Clear();
                return OperatorWriteGrant.ReadStatus();
            }

            var desiredMode = _approvalMode == OperatorApprovalMode.Yolo ? OperatorWriteGrantMode.Yolo : OperatorWriteGrantMode.Session;
            var desiredModeText = desiredMode == OperatorWriteGrantMode.Yolo ? "yolo" : "session";
            var ttl = desiredMode == OperatorWriteGrantMode.Yolo ? TimeSpan.FromHours(8) : TimeSpan.FromMinutes(15);

            var status = OperatorWriteGrant.ReadStatus();
            var expiresSoon = !status.ExpiresAtUtc.HasValue || status.ExpiresAtUtc.Value <= DateTime.UtcNow.Add(WriteGrantRefreshThreshold(_approvalMode));
            var modeMismatch = !string.Equals((status.Mode ?? "").Trim(), desiredModeText, StringComparison.OrdinalIgnoreCase);
            var shouldIssue = forceIssue || !status.Active || modeMismatch || expiresSoon || !string.IsNullOrWhiteSpace(status.Error);

            if (shouldIssue)
            {
                status = OperatorWriteGrant.Issue(desiredMode, ttl);
            }

            return status;
        }

        private void PostWriteGrantStatusToUi(OperatorWriteGrantStatus status)
        {
            try
            {
                PostToUi("write_grant.status", new
                {
                    active = status.Active,
                    mode = status.Mode,
                    expires_at_utc = status.ExpiresAtUtc?.ToString("o"),
                    uses_remaining = status.UsesRemaining,
                    error = status.Error
                });
            }
            catch
            {
                // ignore
            }
        }

        private void EnsureNativeApiPolicyForApprovalMode(bool postToUi, bool announceChat)
        {
            try
            {
                var snapshot = OperatorNativeApiPolicy.Snapshot();
                if (snapshot.Locked)
                {
                    if (postToUi) PostNativeApiPolicyToUi();
                    if (announceChat)
                    {
                        AppendChat("system", "Native API policy is enterprise-locked; leaving the current profile unchanged.", null);
                    }
                    return;
                }

                var desiredProfile = _approvalMode == OperatorApprovalMode.Yolo
                    ? OperatorNativeApiProfile.Unrestricted
                    : (_approvalMode == OperatorApprovalMode.Safe ? OperatorNativeApiProfile.Balanced : OperatorNativeApiProfile.Broad);
                if (snapshot.Profile != desiredProfile)
                {
                    var desiredProfileText = desiredProfile == OperatorNativeApiProfile.Unrestricted
                        ? "unrestricted"
                        : (desiredProfile == OperatorNativeApiProfile.Balanced ? "balanced" : "broad");
                    OperatorNativeApiPolicy.SetPolicy(
                        desiredProfileText,
                        maxRisk: null,
                        allowMutating: null,
                        blockFreezeRisk: null,
                        maxResults: null,
                        maxInvocationParams: null);
                    if (announceChat)
                    {
                        AppendChat("system", $"Native API policy: {desiredProfileText}.", null);
                    }
                }

                if (postToUi) PostNativeApiPolicyToUi();
            }
            catch
            {
                if (postToUi) PostNativeApiPolicyToUi();
            }
        }

        private void PostNativeApiPolicyToUi()
        {
            try
            {
                PostToUi("native_api.policy.current", OperatorNativeApiPolicy.GetStatus());
            }
            catch
            {
                // ignore
            }
        }

        private void PostReasoningEffortToUi()
        {
            try
            {
                PostToUi("reasoning.current", new { effort = NormalizeReasoningEffort(_reasoningEffort) });
            }
            catch
            {
                // ignore
            }
        }

        private static string UiModeString(OperatorApprovalMode mode)
        {
            switch (mode)
            {
                case OperatorApprovalMode.Safe: return "safe";
                case OperatorApprovalMode.AllowWritesThisSession: return "session";
                case OperatorApprovalMode.Yolo: return "yolo";
                default: return "safe";
            }
        }

        private static string NormalizeReasoningEffort(string? value)
        {
            switch ((value ?? "").Trim().ToLowerInvariant())
            {
                case "low": return "low";
                case "medium": return "medium";
                case "high": return "high";
                case "xhigh": return "xhigh";
                default: return "medium";
            }
        }

        private async Task ApproveAndRunAsync(string actionId)
        {
            if (!_pendingApprovals.TryGetValue(actionId, out var action)) return;
            _pendingApprovals.Remove(actionId);
            _turnByApprovalActionId.TryGetValue(actionId, out var turn);
            _turnByApprovalActionId.Remove(actionId);

            Ui(() => UpdateActionStatus(actionId, "pending", null));
            var startedAt = DateTime.UtcNow;
            try
            {
                Ui(() => UpdateActionStatus(actionId, "running", null));
                var result = await ExecuteActionAsync(action, CancellationToken.None).ConfigureAwait(false);
                Ui(() => SetActionResult(actionId, result));
                Ui(() => UpdateActionStatus(actionId, "done", null));

                if (_logger != null)
                {
                    await _logger.LogAsync("action.done", new
                    {
                        backend_session_id = turn?.SessionId,
                        root_message_id = turn?.RootMessageId,
                        action_id = actionId,
                        method = action.Method,
                        path = action.Path,
                        approval_mode = _approvalMode.ToString(),
                        required_approval = true,
                        granted = true,
                        started_at = startedAt.ToString("o"),
                        finished_at = DateTime.UtcNow.ToString("o"),
                        duration_ms = (int)Math.Max(0, (DateTime.UtcNow - startedAt).TotalMilliseconds),
                        result
                    }, CancellationToken.None).ConfigureAwait(false);
                }

                if (turn != null)
                {
                    turn.PendingToolResults.Add(await BuildToolResultAsync(action, startedAt, result, null).ConfigureAwait(false));
                    var list = turn.PendingToolResults;
                    await TryAutoCaptureAfterAsync(turn, action, actionId, list).ConfigureAwait(false);

                    // Track writes so deferred verification can force regenerate.
                    var risk = GetActionRisk(action);
                    if (risk == OperatorActionRisk.High) turn.WriteAppliedInStep = true;

                    // If we just applied titleblock parameter updates, enqueue a sheet-aware verify capture.
                    if (string.Equals(action.Path, "/revit/set-parameter", StringComparison.OrdinalIgnoreCase))
                    {
                        if (TryGetTitleblockSheetIdsFromSetParameterResult(result, out var sheetIds))
                        {
                            foreach (var sid in sheetIds.Take(2))
                            {
                                var verify = new OperatorActionCall
                                {
                                    ActionId = $"{actionId}:__verify_titleblock:{sid}",
                                    Method = "POST",
                                    Path = "/revit/capture-sheet-region",
                                    Body = new { sheetViewId = sid, region = "titleblock", marginFt = 0.15, imageMaxSizePx = 2400, includeMapping = true, fileName = $"verify_titleblock_{sid}" }
                                };
                                try
                                {
                                    var rid = GetActionRisk(verify);
                                    Ui(() => AddAction(verify.ActionId, "POST /revit/capture-sheet-region (verify titleblock)", verify.Path, verify.Body, false, rid));
                                    Ui(() => UpdateActionStatus(verify.ActionId, "deferred", "Will run after apply + regenerate."));
                                }
                                catch { }
                                turn.DeferredActions.Add(verify);
                            }
                        }
                    }

                    turn.PendingApprovals = Math.Max(0, turn.PendingApprovals - 1);
                    if (turn.PendingApprovals == 0)
                    {
                        turn.AwaitingApproval = false;
                        // Deterministic verification: execute any deferred capture/verify actions only after all approvals are applied.
                        await TryRunDeferredVerificationAsync(turn, $"{turn.RootMessageId}:assistant:{Math.Max(1, turn.Step)}", turn.PendingToolResults).ConfigureAwait(false);
                        if (turn.DryRunOnly && (turn.DryRunMutationAttempted || turn.DryRunOnlyBlockedAction))
                            await StopDryRunOnlyTurnAsync(turn, $"{turn.RootMessageId}:assistant:{Math.Max(1, turn.Step)}").ConfigureAwait(false);
                        else
                            _ = ContinueTurnAsync(turn);
                    }
                }
            }
            catch (Exception ex)
            {
                var err = FormatException(ex);
                Ui(() => UpdateActionStatus(actionId, "failed", err));

                if (_logger != null)
                {
                    await _logger.LogAsync("action.failed", new
                    {
                        backend_session_id = turn?.SessionId,
                        root_message_id = turn?.RootMessageId,
                        action_id = actionId,
                        method = action.Method,
                        path = action.Path,
                        approval_mode = _approvalMode.ToString(),
                        required_approval = true,
                        granted = true,
                        duration_ms = (int)Math.Max(0, (DateTime.UtcNow - startedAt).TotalMilliseconds),
                        error = err,
                        type = ex.GetType().FullName
                    }, CancellationToken.None).ConfigureAwait(false);
                }

                if (turn != null)
                {
                    turn.PendingToolResults.Add(await BuildToolResultAsync(action, DateTime.UtcNow, result: null, ex).ConfigureAwait(false));
                    turn.PendingApprovals = Math.Max(0, turn.PendingApprovals - 1);
                    if (turn.PendingApprovals == 0)
                    {
                        turn.AwaitingApproval = false;
                        await TryRunDeferredVerificationAsync(turn, $"{turn.RootMessageId}:assistant:{Math.Max(1, turn.Step)}", turn.PendingToolResults).ConfigureAwait(false);
                        if (turn.DryRunOnly && (turn.DryRunMutationAttempted || turn.DryRunOnlyBlockedAction))
                            await StopDryRunOnlyTurnAsync(turn, $"{turn.RootMessageId}:assistant:{Math.Max(1, turn.Step)}").ConfigureAwait(false);
                        else
                            _ = ContinueTurnAsync(turn);
                    }
                }
            }
        }

        private async Task ContinueTurnAsync(OperatorTurnState turn)
        {
            await _chatLock.WaitAsync().ConfigureAwait(false);
            try
            {
                if (turn.PendingToolResults.Count == 0) return;
                var token = _activeTurnCts?.Token ?? CancellationToken.None;
                _turnBusy = true;
                try
                {
                    await RunToolLoopAsync(turn, userText: "", token).ConfigureAwait(false);
                }
                finally
                {
                    _turnBusy = false;
                }
            }
            finally
            {
                _chatLock.Release();
            }
        }

        private async Task RunPendingApprovalsAsync()
        {
            if (_pendingApprovals.Count == 0) return;

            // Copy keys because we mutate dictionary during execution.
            var keys = new System.Collections.Generic.List<string>(_pendingApprovals.Keys);
            foreach (var k in keys)
            {
                if (!_pendingApprovals.TryGetValue(k, out var action)) continue;
                var risk = GetActionRisk(action);
                if (OperatorApprovalPolicy.RequiresApproval(_approvalMode, risk)) continue;
                await ApproveAndRunAsync(k).ConfigureAwait(false);
            }
        }

        private static bool ShouldAutoCaptureAfter(string? path)
        {
            if (string.IsNullOrWhiteSpace(path)) return false;
            var p = path.Trim();
            if (string.Equals(p, "/revit/place-view", StringComparison.OrdinalIgnoreCase)) return true;
            if (string.Equals(p, "/revit/create-family-instance", StringComparison.OrdinalIgnoreCase)) return true;
            if (string.Equals(p, "/revit/move-elements", StringComparison.OrdinalIgnoreCase)) return true;
            if (string.Equals(p, "/revit/rotate-elements", StringComparison.OrdinalIgnoreCase)) return true;
            return false;
        }

        private async Task TryAutoCaptureAfterAsync(
            OperatorTurnState? turn,
            OperatorActionCall executedAction,
            string executedActionId,
            System.Collections.Generic.List<OperatorToolResult> toolResultsSink)
        {
            try
            {
                if (turn == null) return;
                if (!ShouldAutoCaptureAfter(executedAction.Path)) return;

                // Avoid infinite loops / redundant captures.
                if (string.Equals(executedAction.Path, "/revit/export-image", StringComparison.OrdinalIgnoreCase)) return;
                if (string.Equals(executedAction.Path, "/revit/export-view-frame", StringComparison.OrdinalIgnoreCase)) return;
                if (string.Equals(executedAction.Path, "/revit/export-view-region", StringComparison.OrdinalIgnoreCase)) return;
                if (string.Equals(executedAction.Path, "/revit/export-visible-elements", StringComparison.OrdinalIgnoreCase)) return;

                // Keep within the typical "max images" budget (3).
                int existingImages = 0;
                foreach (var existingTr in toolResultsSink)
                {
                    if (existingTr.Attachments == null) continue;
                    foreach (var a in existingTr.Attachments)
                    {
                        if (a != null && string.Equals(a.Kind, "image", StringComparison.OrdinalIgnoreCase))
                            existingImages++;
                    }
                }
                if (existingImages >= 3) return;

                var capture = new OperatorActionCall
                {
                    ActionId = $"{executedActionId}:__auto_capture",
                    Method = "POST",
                    Path = "/revit/export-image",
                    Body = new { imageSize = 1800 }
                };

                var startedAt = DateTime.UtcNow;
                object? result = null;
                Exception? error = null;
                try
                {
                    result = await ExecuteActionAsync(capture, CancellationToken.None).ConfigureAwait(false);
                }
                catch (Exception ex)
                {
                    error = ex;
                }

                var captureTr = await BuildToolResultAsync(capture, startedAt, result, error).ConfigureAwait(false);
                toolResultsSink.Add(captureTr);

                if (_logger != null)
                {
                    await _logger.LogAsync("verify.capture", new
                    {
                        backend_session_id = turn.SessionId,
                        root_message_id = turn.RootMessageId,
                        after_action_id = executedActionId,
                        capture_action_id = capture.ActionId,
                        path = capture.Path,
                        status = captureTr.Status,
                        result = captureTr.ResultJson,
                        error = captureTr.Error
                    }, CancellationToken.None).ConfigureAwait(false);
                }
            }
            catch
            {
                // best effort
            }
        }
    }
}
