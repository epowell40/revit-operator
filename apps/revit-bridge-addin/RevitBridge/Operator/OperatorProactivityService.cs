using System;
using System.Collections.Generic;
using System.Threading;
using System.Threading.Tasks;
using Autodesk.Revit.DB;
using RevitBridge.Services;

namespace RevitBridge.Operator
{
    internal sealed class OperatorProactivityService : IDisposable
    {
        private sealed class WarningsSnapshot
        {
            public string DocumentTitle { get; set; } = "";
            public string DocumentPath { get; set; } = "";
            public int WarningCount { get; set; }
        }

        private readonly RevitEventService _eventService;
        private readonly OperatorBackendClient _backendClient;
        private readonly Func<string?> _getSessionId;
        private readonly Func<OperatorJsonlLogger?> _getLogger;
        private readonly Action<string, string, string?> _appendChat;
        private readonly Func<OperatorBackendClient.OperatorNotification, bool>? _handleNotification;
        private readonly CancellationTokenSource _cts = new CancellationTokenSource();
        private Task? _pollTask;
        private Task? _warningsTask;

        private string? _activeSessionId;
        private long _afterNotificationId;
        private readonly Dictionary<string, int> _lastWarningsByDoc = new Dictionary<string, int>(StringComparer.OrdinalIgnoreCase);

        public OperatorProactivityService(
            RevitEventService eventService,
            OperatorBackendClient backendClient,
            Func<string?> getSessionId,
            Func<OperatorJsonlLogger?> getLogger,
            Action<string, string, string?> appendChat,
            Func<OperatorBackendClient.OperatorNotification, bool>? handleNotification = null)
        {
            _eventService = eventService;
            _backendClient = backendClient;
            _getSessionId = getSessionId;
            _getLogger = getLogger;
            _appendChat = appendChat;
            _handleNotification = handleNotification;
        }

        public void Start()
        {
            if (_pollTask != null || _warningsTask != null) return;
            _pollTask = Task.Run(() => PollNotificationsLoopAsync(_cts.Token));
            _warningsTask = Task.Run(() => WarningsWatcherLoopAsync(_cts.Token));
        }

        public void OnSessionChanged(string? sessionId)
        {
            if (string.Equals(_activeSessionId, sessionId, StringComparison.Ordinal)) return;
            _activeSessionId = sessionId;
            _afterNotificationId = 0;
            _lastWarningsByDoc.Clear();
        }

        public void Dispose()
        {
            try { _cts.Cancel(); } catch { }
            try { _pollTask?.Wait(250); } catch { }
            try { _warningsTask?.Wait(250); } catch { }
            try { _cts.Dispose(); } catch { }
        }

        private async Task PollNotificationsLoopAsync(CancellationToken cancellationToken)
        {
            while (!cancellationToken.IsCancellationRequested)
            {
                var sid = _getSessionId();
                if (string.IsNullOrWhiteSpace(sid))
                {
                    await Task.Delay(2000, cancellationToken).ConfigureAwait(false);
                    continue;
                }

                if (!string.Equals(_activeSessionId, sid, StringComparison.Ordinal)) OnSessionChanged(sid);

                try
                {
                    var resp = await _backendClient.GetNotificationsAsync(sid!, _afterNotificationId, cancellationToken).ConfigureAwait(false);
                    if (resp.Notifications != null)
                    {
                        foreach (var n in resp.Notifications)
                        {
                            if (n == null) continue;
                            if (n.Id <= 0) continue;
                            var handled = false;
                            try
                            {
                                handled = _handleNotification?.Invoke(n) ?? false;
                            }
                            catch
                            {
                                handled = false;
                            }
                            if (!handled && !string.IsNullOrWhiteSpace(n.Text))
                            {
                                _appendChat("system", n.Text, $"notify:{n.Id}");
                            }

                            var logger = _getLogger();
                            if (logger != null)
                            {
                                _ = logger.LogAsync("notify.in", new
                                {
                                    backend_session_id = sid,
                                    notification_id = n.Id,
                                    type = n.Type,
                                    text = n.Text
                                }, CancellationToken.None);
                            }
                        }
                    }

                    if (resp.NextAfterId > _afterNotificationId) _afterNotificationId = resp.NextAfterId;
                }
                catch
                {
                    // best-effort
                }

                await Task.Delay(4000, cancellationToken).ConfigureAwait(false);
            }
        }

        private async Task WarningsWatcherLoopAsync(CancellationToken cancellationToken)
        {
            while (!cancellationToken.IsCancellationRequested)
            {
                var sid = _getSessionId();
                if (string.IsNullOrWhiteSpace(sid))
                {
                    await Task.Delay(5000, cancellationToken).ConfigureAwait(false);
                    continue;
                }

                if (!string.Equals(_activeSessionId, sid, StringComparison.Ordinal)) OnSessionChanged(sid);

                WarningsSnapshot? snapshot = null;
                try
                {
                    // Revit can accept an ExternalEvent while it is still on Home or
                    // opening a document without ever invoking the callback. Never let
                    // this best-effort watcher own the single-flight queue indefinitely;
                    // cancellation removes the pending item and releases the slot.
                    using var hostReadTimeout = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
                    hostReadTimeout.CancelAfter(TimeSpan.FromSeconds(5));
                    snapshot = await _eventService.Run(app =>
                    {
                        var doc = app?.ActiveUIDocument?.Document;
                        if (doc == null) return null;
                        var warnings = doc.GetWarnings();
                        return new WarningsSnapshot
                        {
                            DocumentTitle = doc.Title ?? "",
                            DocumentPath = doc.PathName ?? "",
                            WarningCount = warnings?.Count ?? 0
                        };
                    }, hostReadTimeout.Token).ConfigureAwait(false);
                }
                catch
                {
                    snapshot = null;
                }

                if (snapshot != null)
                {
                    var docKey = !string.IsNullOrWhiteSpace(snapshot.DocumentPath) ? snapshot.DocumentPath : snapshot.DocumentTitle;
                    docKey = (docKey ?? "").Trim();
                    if (!string.IsNullOrWhiteSpace(docKey))
                    {
                        _lastWarningsByDoc.TryGetValue(docKey, out var lastCount);
                        var current = snapshot.WarningCount;
                        var delta = current - lastCount;

                        // Only push on upward "spikes" to avoid noise.
                        if (delta >= 10)
                        {
                            try
                            {
                                await _backendClient.PostEventAsync(sid!, "warnings.count", new
                                {
                                    warning_count = current,
                                    delta = delta,
                                    document_title = snapshot.DocumentTitle,
                                    document_path = snapshot.DocumentPath
                                }, cancellationToken).ConfigureAwait(false);

                                var logger = _getLogger();
                                if (logger != null)
                                {
                                    _ = logger.LogAsync("watcher.warnings.sent", new
                                    {
                                        backend_session_id = sid,
                                        document_title = snapshot.DocumentTitle,
                                        document_path = snapshot.DocumentPath,
                                        warning_count = current,
                                        delta = delta
                                    }, CancellationToken.None);
                                }
                            }
                            catch
                            {
                                // best-effort
                            }
                        }

                        _lastWarningsByDoc[docKey] = current;
                    }
                }

                await Task.Delay(30000, cancellationToken).ConfigureAwait(false);
            }
        }
    }
}

