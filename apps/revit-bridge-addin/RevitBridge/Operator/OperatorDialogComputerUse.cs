using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Imaging;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.Json;
using Autodesk.Revit.UI;
using Autodesk.Revit.UI.Events;
using RevitBridge.Common;

namespace RevitBridge.Operator
{
    internal sealed partial class OperatorDialogComputerUse : IDisposable
    {
        private const int DefaultMaxDialogs = 6;
        private const int DefaultScreenshotMaxSidePx = 1600;
        private const int BM_CLICK = 0x00F5;
        private const uint MOUSEEVENTF_LEFTDOWN = 0x0002;
        private const uint MOUSEEVENTF_LEFTUP = 0x0004;
        private const uint GW_OWNER = 4;
        private const int GWL_STYLE = -16;
        private const long BS_DEFPUSHBUTTON = 0x00000001L;

        private readonly UIControlledApplication _application;
        private readonly object _gate = new object();
        private readonly List<DialogGuardRule> _guards = new List<DialogGuardRule>();
        private long _nextEventId;
        private long _nextGuardId;
        private DialogEventRecord? _lastEvent;

        public OperatorDialogComputerUse(UIControlledApplication application)
        {
            _application = application ?? throw new ArgumentNullException(nameof(application));
            _application.DialogBoxShowing += OnDialogBoxShowing;
        }

        public object Observe(UIApplication? app, ObserveParams? request)
        {
            var maxDialogs = Clamp(request?.maxDialogs ?? DefaultMaxDialogs, 1, 20);
            var includeScreenshot = request?.includeScreenshot ?? true;
            var screenshotMaxSidePx = Clamp(request?.screenshotMaxSidePx ?? DefaultScreenshotMaxSidePx, 320, 3200);
            var titleContains = NormalizeToken(request?.titleContains);
            var dialogIdContains = NormalizeToken(request?.dialogIdContains);
            var onlyModal = request?.onlyModal ?? false;

            var dialogs = EnumerateDialogs(maxDialogs, onlyModal);
            if (!string.IsNullOrWhiteSpace(titleContains))
            {
                dialogs = dialogs.Where(x => ContainsNormalized(x.Title, titleContains)).ToList();
            }

            if (!string.IsNullOrWhiteSpace(dialogIdContains))
            {
                var last = GetLastEventSnapshot();
                if (last == null || !ContainsNormalized(last.DialogId, dialogIdContains))
                {
                    dialogs = new List<DialogWindowSnapshot>();
                }
            }

            string? screenshotPath = null;
            var target = dialogs.FirstOrDefault(x => x.IsTopMost) ?? dialogs.FirstOrDefault();
            if (includeScreenshot && target != null)
            {
                try { screenshotPath = CaptureDialogScreenshot(target.Hwnd, screenshotMaxSidePx, "observe"); }
                catch { screenshotPath = null; }
            }

            return BuildObserveResult("ok", app, dialogs, screenshotPath, null);
        }

        public object Act(UIApplication? app, ActParams? request)
        {
            var selection = ButtonSelection.From(request?.button, request?.buttonText, request?.buttonIndex);
            if (selection.IsEmpty)
            {
                selection = ButtonSelection.Default();
            }
            var interactionMode = InteractionModeSelection.From(request?.interactionMode);
            var cursorRestoreMode = CursorRestoreSelection.From(request?.cursorRestoreMode);

            var result = ExecuteButtonAction(
                selection,
                interactionMode,
                cursorRestoreMode,
                titleContains: NormalizeToken(request?.titleContains),
                dialogIdContains: NormalizeToken(request?.dialogIdContains),
                waitForDialogMs: Clamp(request?.waitForDialogMs ?? 0, 0, 5000),
                includeScreenshotAfter: request?.includeScreenshotAfter ?? true,
                screenshotMaxSidePx: Clamp(request?.screenshotMaxSidePx ?? DefaultScreenshotMaxSidePx, 320, 3200),
                reason: "manual");

            return BuildActResult("act", app, result);
        }

        public object ArmGuard(GuardParams? request)
        {
            var selection = ButtonSelection.From(request?.button, request?.buttonText, request?.buttonIndex);
            if (selection.IsEmpty)
            {
                selection = ButtonSelection.Default();
            }

            var guard = new DialogGuardRule
            {
                GuardId = System.Threading.Interlocked.Increment(ref _nextGuardId),
                CreatedAtUtc = DateTime.UtcNow,
                ExpiresAtUtc = DateTime.UtcNow.AddMilliseconds(Clamp(request?.ttlMs ?? 60000, 1000, 600000)),
                MaxTriggers = Clamp(request?.maxTriggers ?? 1, 1, 20),
                TitleContains = NormalizeToken(request?.titleContains),
                DialogIdContains = NormalizeToken(request?.dialogIdContains),
                MessageContains = NormalizeToken(request?.messageContains),
                Selection = selection,
                InteractionMode = InteractionModeSelection.From(request?.interactionMode),
                CursorRestoreMode = CursorRestoreSelection.From(request?.cursorRestoreMode),
                IncludeScreenshotAfter = request?.includeScreenshotAfter ?? false,
                ScreenshotMaxSidePx = Clamp(request?.screenshotMaxSidePx ?? DefaultScreenshotMaxSidePx, 320, 3200)
            };

            lock (_gate)
            {
                CleanupExpiredGuards_NoLock();
                _guards.Add(guard);
            }

            return new
            {
                status = "armed",
                guard_id = guard.GuardId.ToString(CultureInfo.InvariantCulture),
                created_at = guard.CreatedAtUtc.ToString("o"),
                expires_at = guard.ExpiresAtUtc.ToString("o"),
                max_triggers = guard.MaxTriggers,
                trigger_count = guard.TriggerCount,
                button = guard.Selection.Describe(),
                interaction_mode = guard.InteractionMode.Describe(),
                cursor_restore_mode = guard.CursorRestoreMode.Describe(),
                match = new
                {
                    title_contains = guard.TitleContains,
                    dialog_id_contains = guard.DialogIdContains,
                    message_contains = guard.MessageContains
                }
            };
        }

        public void Dispose()
        {
            try
            {
                _application.DialogBoxShowing -= OnDialogBoxShowing;
            }
            catch
            {
                // ignore shutdown races
            }
        }

        private void OnDialogBoxShowing(object sender, DialogBoxShowingEventArgs args)
        {
            var record = new DialogEventRecord
            {
                EventId = System.Threading.Interlocked.Increment(ref _nextEventId),
                CapturedAtUtc = DateTime.UtcNow,
                EventType = args?.GetType().Name ?? "DialogBoxShowingEventArgs",
                DialogId = TryReadStringProperty(args, "DialogId"),
                Message = TryReadStringProperty(args, "Message")
            };
            var policy = ClassifyDialog(record);
            record.PolicyCategory = policy.Category;
            record.PolicyAction = policy.Action;

            DialogGuardRule? matchedGuard = null;
            lock (_gate)
            {
                CleanupExpiredGuards_NoLock();
                _lastEvent = record;
                matchedGuard = _guards.FirstOrDefault(g => g.CanTrigger(record));
                if (matchedGuard != null)
                {
                    record.MatchedGuardId = matchedGuard.GuardId.ToString(CultureInfo.InvariantCulture);
                }
            }

            LogDialogEvent(record);

            if (matchedGuard == null)
            {
                TryApplySafePolicy(args, record, policy);
                return;
            }

            var copy = matchedGuard.Clone();
            _ = System.Threading.Tasks.Task.Run(async () =>
            {
                try
                {
                    await System.Threading.Tasks.Task.Delay(180).ConfigureAwait(false);
                    var action = ExecuteButtonAction(
                        copy.Selection,
                        copy.InteractionMode,
                        copy.CursorRestoreMode,
                        titleContains: copy.TitleContains,
                        dialogIdContains: copy.DialogIdContains,
                        waitForDialogMs: 3500,
                        includeScreenshotAfter: copy.IncludeScreenshotAfter,
                        screenshotMaxSidePx: copy.ScreenshotMaxSidePx,
                        reason: $"guard:{copy.GuardId.ToString(CultureInfo.InvariantCulture)}");
                    lock (_gate)
                    {
                        if (action.Clicked)
                        {
                            var liveGuard = _guards.FirstOrDefault(x => x.GuardId == copy.GuardId);
                            if (liveGuard != null)
                            {
                                liveGuard.TriggerCount++;
                                if (liveGuard.TriggerCount >= liveGuard.MaxTriggers)
                                {
                                    _guards.Remove(liveGuard);
                                }
                            }
                        }

                    if (_lastEvent != null && _lastEvent.EventId == record.EventId)
                    {
                            _lastEvent.MatchedGuardId = action.Clicked ? copy.GuardId.ToString(CultureInfo.InvariantCulture) : null;
                            _lastEvent.ActionStatus = action.Clicked ? "clicked" : "failed";
                            _lastEvent.ActionError = action.Clicked ? null : action.Error;
                            _lastEvent.ClickedButton = action.ClickedButton;
                            _lastEvent.ScreenshotPath = action.ScreenshotPath;
                            _lastEvent.ResolvedAtUtc = DateTime.UtcNow;
                        }
                    }
                    LogDialogEvent(_lastEvent ?? record);
                }
                catch (Exception ex)
                {
                    lock (_gate)
                    {
                        if (_lastEvent != null && _lastEvent.EventId == record.EventId)
                        {
                            _lastEvent.ActionStatus = "failed";
                            _lastEvent.ActionError = ex.Message;
                            _lastEvent.ResolvedAtUtc = DateTime.UtcNow;
                            LogDialogEvent(_lastEvent);
                        }
                    }
                }
            });
        }

        private static DialogPolicyDecision ClassifyDialog(DialogEventRecord record)
        {
            var id = NormalizeToken(record.DialogId) ?? "";
            var msg = NormalizeToken(record.Message) ?? "";
            if (id.Contains("project_not_saved_recently") || msg.Contains("not saved your project recently"))
            {
                return new DialogPolicyDecision("safe_cancel", "cancel_save_reminder");
            }
            var destructive = "delete|remove|purge|overwrite|synchronize|central|relinquish|detach|upgrade|save changes|unrecoverable";
            if (System.Text.RegularExpressions.Regex.IsMatch($"{id} {msg}", destructive, System.Text.RegularExpressions.RegexOptions.IgnoreCase))
            {
                return new DialogPolicyDecision("requires_user_approval", "block_for_user");
            }
            if (id.Contains("docwarndialog"))
            {
                return new DialogPolicyDecision("retryable_error", "observe_warning_then_default_cancel_or_recover");
            }
            if (msg.Contains("can't be ignored") || msg.Contains("cannot be ignored") || msg.Contains("failed") || msg.Contains("error"))
            {
                return new DialogPolicyDecision("retryable_error", "report_step_failed");
            }
            if (msg.Contains("warning") || msg.Contains("none of the created elements are visible") || msg.Contains("identical instances"))
            {
                return new DialogPolicyDecision("safe_ok", "log_only");
            }
            if (id.Contains("taskdialog") && (msg.Contains("operation completed") || msg.Contains("completed successfully")))
            {
                return new DialogPolicyDecision("safe_ok", "log_only");
            }
            return new DialogPolicyDecision("blocker", "report_unknown_blocker");
        }

        private static void TryApplySafePolicy(DialogBoxShowingEventArgs args, DialogEventRecord record, DialogPolicyDecision policy)
        {
            if (!string.Equals(policy.Category, "safe_ok", StringComparison.OrdinalIgnoreCase)) return;
            var enabled = string.Equals(Environment.GetEnvironmentVariable("OPERATOR_DIALOG_GUARDIAN_AUTO_OK_SAFE"), "1", StringComparison.OrdinalIgnoreCase);
            if (!enabled) return;
            try
            {
                args.OverrideResult(1);
                record.ActionStatus = "auto_dismissed";
                record.ClickedButton = "ok";
                record.ResolvedAtUtc = DateTime.UtcNow;
                LogDialogEvent(record);
            }
            catch (Exception ex)
            {
                record.ActionStatus = "auto_dismiss_failed";
                record.ActionError = ex.Message;
                record.ResolvedAtUtc = DateTime.UtcNow;
                LogDialogEvent(record);
            }
        }

        private static void LogDialogEvent(DialogEventRecord record)
        {
            try
            {
                var root = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "RevitOperator", "Workspace", "logs");
                Directory.CreateDirectory(root);
                var payload = new
                {
                    schema = "operator.dialog_guardian.event.v1",
                    event_id = record.EventId,
                    timestamp = record.CapturedAtUtc.ToString("o"),
                    dialog_id = record.DialogId,
                    title = "",
                    message = record.Message,
                    policy_category = record.PolicyCategory,
                    selected_action = record.PolicyAction,
                    matched_guard_id = record.MatchedGuardId,
                    action_status = record.ActionStatus,
                    action_error = record.ActionError,
                    clicked_button = record.ClickedButton,
                    screenshot_path = record.ScreenshotPath,
                    resolved_at = record.ResolvedAtUtc?.ToString("o")
                };
                File.AppendAllText(Path.Combine(root, "dialog-guardian.jsonl"), JsonSerializer.Serialize(payload) + Environment.NewLine, Encoding.UTF8);
            }
            catch
            {
                // never let logging affect Revit dialog handling
            }
        }

        private object BuildObserveResult(string action, UIApplication? app, List<DialogWindowSnapshot> dialogs, string? screenshotPath, string? warning)
        {
            var last = GetLastEventSnapshot();
            var topMost = dialogs.FirstOrDefault(x => x.IsTopMost) ?? dialogs.FirstOrDefault();
            var mainWindowHandle = app?.MainWindowHandle ?? Process.GetCurrentProcess().MainWindowHandle;
            return new
            {
                status = "ok",
                action,
                captured_at = DateTime.UtcNow.ToString("o"),
                active_window = new
                {
                    process_id = Process.GetCurrentProcess().Id,
                    main_window_title = Safe(() => Process.GetCurrentProcess().MainWindowTitle),
                    main_window_handle = FormatHandle(mainWindowHandle)
                },
                blocked_by_modal = dialogs.Any(x => x.IsModal),
                dialog_count = dialogs.Count,
                top_most_title = topMost?.Title,
                screenshot_path = screenshotPath,
                dialogs = dialogs.Select(ToWireDialog).ToList(),
                last_dialog_event = last == null ? null : new
                {
                    event_id = last.EventId.ToString(CultureInfo.InvariantCulture),
                    captured_at = last.CapturedAtUtc.ToString("o"),
                    event_type = last.EventType,
                    dialog_id = last.DialogId,
                    message = last.Message,
                    policy_category = last.PolicyCategory,
                    selected_action = last.PolicyAction,
                    matched_guard_id = last.MatchedGuardId,
                    action_status = last.ActionStatus,
                    action_error = last.ActionError,
                    clicked_button = last.ClickedButton,
                    screenshot_path = last.ScreenshotPath,
                    resolved_at = last.ResolvedAtUtc?.ToString("o")
                },
                warning
            };
        }

        private object BuildActResult(string action, UIApplication? app, ButtonActionResult result)
        {
            var dialogs = EnumerateDialogs(DefaultMaxDialogs, onlyModal: false);
            return new
            {
                status = result.Clicked ? "ok" : "failed",
                action,
                clicked = result.Clicked,
                dialog_title = result.DialogTitle,
                dialog_handle = result.DialogHandle,
                clicked_button = result.ClickedButton,
                click_method = result.ClickMethod,
                message_click_attempted = result.MessageClickAttempted,
                mouse_fallback_used = result.MouseFallbackUsed,
                mouse_fallback_reason = result.MouseFallbackReason,
                cursor_restored = result.CursorRestored,
                cursor_restore_error = result.CursorRestoreError,
                screenshot_path = result.ScreenshotPath,
                error = result.Error,
                observe = BuildObserveResult(action + "_observe", app, dialogs, null, null)
            };
        }

        private ButtonActionResult ExecuteButtonAction(
            ButtonSelection selection,
            InteractionModeSelection interactionMode,
            CursorRestoreSelection cursorRestoreMode,
            string? titleContains,
            string? dialogIdContains,
            int waitForDialogMs,
            bool includeScreenshotAfter,
            int screenshotMaxSidePx,
            string reason)
        {
            var started = Environment.TickCount;
            var mainWindowHandle = Process.GetCurrentProcess().MainWindowHandle;
            DialogWindowSnapshot? target = null;

            while (true)
            {
                var dialogs = EnumerateDialogs(DefaultMaxDialogs, onlyModal: false);
                target = ChooseTargetDialog(dialogs, titleContains, dialogIdContains);
                if (target != null)
                {
                    break;
                }

                if (waitForDialogMs <= 0 || Environment.TickCount - started >= waitForDialogMs)
                {
                    return new ButtonActionResult
                    {
                        Clicked = false,
                        Error = "No matching Revit dialog was found.",
                        DialogHandle = FormatHandle(IntPtr.Zero)
                    };
                }

                System.Threading.Thread.Sleep(120);
            }

            var button = ChooseButton(target, selection);
            if (button == null)
            {
                return new ButtonActionResult
                {
                    Clicked = false,
                    Error = $"No matching button found on dialog '{target.Title}'.",
                    DialogTitle = target.Title,
                    DialogHandle = FormatHandle(target.Hwnd)
                };
            }

            if (interactionMode.Mode == InteractionMode.Mouse)
            {
                return ExecuteMouseButtonAction(target, button, cursorRestoreMode, includeScreenshotAfter, screenshotMaxSidePx, reason, "requested_mouse");
            }

            var messageResult = ExecuteMessageButtonAction(
                mainWindowHandle,
                target,
                button,
                includeScreenshotAfter,
                screenshotMaxSidePx,
                reason);

            if (interactionMode.Mode == InteractionMode.Message)
            {
                return messageResult;
            }

            if (messageResult.Clicked && !IsDialogStillVisible(target.Hwnd))
            {
                return messageResult;
            }

            var fallbackReason = messageResult.Clicked
                ? "dialog_still_visible_after_message_click"
                : "message_click_failed";

            var mouseResult = ExecuteMouseButtonAction(
                target,
                button,
                cursorRestoreMode,
                includeScreenshotAfter,
                screenshotMaxSidePx,
                reason,
                fallbackReason);

            mouseResult.MessageClickAttempted = true;
            mouseResult.MouseFallbackUsed = true;
            mouseResult.MouseFallbackReason = fallbackReason;
            if (!mouseResult.Clicked && messageResult.Clicked)
            {
                mouseResult.Error = "Message click left the dialog visible and mouse fallback failed: " + mouseResult.Error;
            }
            return mouseResult;
        }

        private ButtonActionResult ExecuteMessageButtonAction(
            IntPtr mainWindowHandle,
            DialogWindowSnapshot target,
            DialogButtonSnapshot button,
            bool includeScreenshotAfter,
            int screenshotMaxSidePx,
            string reason)
        {
            try
            {
                try { SetForegroundWindow(target.Hwnd); } catch { }
                try { SetForegroundWindow(mainWindowHandle); } catch { }
                SendMessage(button.Hwnd, BM_CLICK, IntPtr.Zero, IntPtr.Zero);
                System.Threading.Thread.Sleep(120);

                return BuildButtonActionSuccess(
                    target,
                    button,
                    includeScreenshotAfter,
                    screenshotMaxSidePx,
                    reason,
                    clickMethod: "message",
                    messageClickAttempted: true,
                    mouseFallbackUsed: false,
                    mouseFallbackReason: null,
                    cursorRestored: null,
                    cursorRestoreError: null);
            }
            catch (Exception ex)
            {
                return new ButtonActionResult
                {
                    Clicked = false,
                    Error = ex.Message,
                    DialogTitle = target.Title,
                    DialogHandle = FormatHandle(target.Hwnd),
                    ClickMethod = "message",
                    MessageClickAttempted = true
                };
            }
        }

        private ButtonActionResult ExecuteMouseButtonAction(
            DialogWindowSnapshot target,
            DialogButtonSnapshot button,
            CursorRestoreSelection cursorRestoreMode,
            bool includeScreenshotAfter,
            int screenshotMaxSidePx,
            string reason,
            string fallbackReason)
        {
            POINT originalPoint = default;
            var hadOriginalPoint = false;
            string? restoreError = null;
            try
            {
                if (!GetWindowRect(button.Hwnd, out var buttonRect))
                {
                    throw new InvalidOperationException("Could not read target button bounds for mouse fallback.");
                }

                var x = buttonRect.Left + Math.Max(1, buttonRect.Right - buttonRect.Left) / 2;
                var y = buttonRect.Top + Math.Max(1, buttonRect.Bottom - buttonRect.Top) / 2;
                hadOriginalPoint = GetCursorPos(out originalPoint);

                try { SetForegroundWindow(target.Hwnd); } catch { }
                System.Threading.Thread.Sleep(50);
                if (!SetCursorPos(x, y))
                {
                    throw new InvalidOperationException("SetCursorPos failed during mouse fallback.");
                }
                System.Threading.Thread.Sleep(30);
                mouse_event(MOUSEEVENTF_LEFTDOWN, 0, 0, 0, UIntPtr.Zero);
                System.Threading.Thread.Sleep(20);
                mouse_event(MOUSEEVENTF_LEFTUP, 0, 0, 0, UIntPtr.Zero);
                System.Threading.Thread.Sleep(120);

                return BuildButtonActionSuccess(
                    target,
                    button,
                    includeScreenshotAfter,
                    screenshotMaxSidePx,
                    reason,
                    clickMethod: "mouse",
                    messageClickAttempted: false,
                    mouseFallbackUsed: true,
                    mouseFallbackReason: fallbackReason,
                    cursorRestored: cursorRestoreMode.Restore ? TryRestoreCursor(hadOriginalPoint, originalPoint, out restoreError) : false,
                    cursorRestoreError: restoreError);
            }
            catch (Exception ex)
            {
                var restored = cursorRestoreMode.Restore ? TryRestoreCursor(hadOriginalPoint, originalPoint, out restoreError) : false;
                return new ButtonActionResult
                {
                    Clicked = false,
                    Error = ex.Message,
                    DialogTitle = target.Title,
                    DialogHandle = FormatHandle(target.Hwnd),
                    ClickedButton = button.Label,
                    ClickMethod = "mouse",
                    MouseFallbackUsed = true,
                    MouseFallbackReason = fallbackReason,
                    CursorRestored = restored,
                    CursorRestoreError = restoreError
                };
            }
        }

        private ButtonActionResult BuildButtonActionSuccess(
            DialogWindowSnapshot target,
            DialogButtonSnapshot button,
            bool includeScreenshotAfter,
            int screenshotMaxSidePx,
            string reason,
            string clickMethod,
            bool messageClickAttempted,
            bool mouseFallbackUsed,
            string? mouseFallbackReason,
            bool? cursorRestored,
            string? cursorRestoreError)
        {
            string? screenshotPath = null;
            if (includeScreenshotAfter)
            {
                try { screenshotPath = CaptureDialogScreenshot(target.Hwnd, screenshotMaxSidePx, reason); }
                catch { screenshotPath = null; }
            }

            return new ButtonActionResult
            {
                Clicked = true,
                DialogTitle = target.Title,
                DialogHandle = FormatHandle(target.Hwnd),
                ClickedButton = button.Label,
                ClickMethod = clickMethod,
                MessageClickAttempted = messageClickAttempted,
                MouseFallbackUsed = mouseFallbackUsed,
                MouseFallbackReason = mouseFallbackReason,
                CursorRestored = cursorRestored,
                CursorRestoreError = cursorRestoreError,
                ScreenshotPath = screenshotPath
            };
        }

        private static bool? TryRestoreCursor(bool hadOriginalPoint, POINT originalPoint, out string? error)
        {
            error = null;
            if (!hadOriginalPoint) return null;
            try
            {
                if (!SetCursorPos(originalPoint.X, originalPoint.Y))
                {
                    error = "SetCursorPos failed while restoring cursor.";
                    return false;
                }
                return true;
            }
            catch (Exception ex)
            {
                error = ex.Message;
                return false;
            }
        }

        private bool IsDialogStillVisible(IntPtr hwnd)
        {
            if (hwnd == IntPtr.Zero) return false;
            try
            {
                return EnumerateDialogs(DefaultMaxDialogs, onlyModal: false).Any(x => x.Hwnd == hwnd);
            }
            catch
            {
                return false;
            }
        }

        private static DialogWindowSnapshot? ChooseTargetDialog(IEnumerable<DialogWindowSnapshot> dialogs, string? titleContains, string? dialogIdContains)
        {
            var list = dialogs?.ToList() ?? new List<DialogWindowSnapshot>();
            if (!string.IsNullOrWhiteSpace(titleContains))
            {
                var byTitle = list.FirstOrDefault(x => ContainsNormalized(x.Title, titleContains));
                if (byTitle != null) return byTitle;
            }

            if (!string.IsNullOrWhiteSpace(dialogIdContains))
            {
                var last = App.Instance?.DialogComputerUse?.GetLastEventSnapshot();
                if (last != null && ContainsNormalized(last.DialogId, dialogIdContains))
                {
                    var top = list.FirstOrDefault(x => x.IsTopMost);
                    if (top != null) return top;
                }
            }

            return list.FirstOrDefault(x => x.IsTopMost && x.IsModal)
                ?? list.FirstOrDefault(x => x.IsTopMost)
                ?? list.FirstOrDefault(x => x.IsModal)
                ?? list.FirstOrDefault();
        }

        private static DialogButtonSnapshot? ChooseButton(DialogWindowSnapshot dialog, ButtonSelection selection)
        {
            if (dialog == null || dialog.Buttons.Count == 0) return null;

            if (selection.ButtonIndex.HasValue)
            {
                var idx = selection.ButtonIndex.Value - 1;
                if (idx >= 0 && idx < dialog.Buttons.Count) return dialog.Buttons[idx];
            }

            if (!string.IsNullOrWhiteSpace(selection.ButtonText))
            {
                var exact = dialog.Buttons.FirstOrDefault(x => LabelEquals(x.Label, selection.ButtonText));
                if (exact != null) return exact;
                var contains = dialog.Buttons.FirstOrDefault(x => ContainsNormalized(x.Label, selection.ButtonText));
                if (contains != null) return contains;
            }

            if (!string.IsNullOrWhiteSpace(selection.ButtonToken))
            {
                var token = NormalizeToken(selection.ButtonToken);
                if (string.Equals(token, "default", StringComparison.Ordinal))
                {
                    return dialog.Buttons.FirstOrDefault(x => x.IsDefault) ?? dialog.Buttons.FirstOrDefault();
                }

                var mapped = dialog.Buttons.FirstOrDefault(x => ButtonTokenMatchesLabel(token, x.Label));
                if (mapped != null) return mapped;
            }

            return dialog.Buttons.FirstOrDefault(x => x.IsDefault) ?? dialog.Buttons.FirstOrDefault();
        }

        private DialogEventRecord? GetLastEventSnapshot()
        {
            lock (_gate)
            {
                if (_lastEvent == null) return null;
                return _lastEvent.Clone();
            }
        }

        internal long CaptureEventCursor()
        {
            lock (_gate)
            {
                return _lastEvent?.EventId ?? 0;
            }
        }

        internal string? ArmRetryableWarningCancelGuard()
        {
            var response = ArmGuard(new GuardParams
            {
                button = "cancel",
                dialogIdContains = "Dialog_Revit_DocWarnDialog",
                interactionMode = "message_then_mouse",
                cursorRestoreMode = "keep",
                ttlMs = 120000,
                maxTriggers = 1,
                includeScreenshotAfter = false
            });
            return response.GetType().GetProperty("guard_id")?.GetValue(response)?.ToString();
        }

        internal void DisarmGuard(string? guardId)
        {
            if (!long.TryParse(guardId, NumberStyles.Integer, CultureInfo.InvariantCulture, out var parsed)) return;
            lock (_gate)
            {
                _guards.RemoveAll(guard => guard.GuardId == parsed);
            }
        }

        internal ResolvedDialogRecovery? GetResolvedRetryableRecoveryAfter(long eventCursor)
        {
            lock (_gate)
            {
                if (_lastEvent == null || _lastEvent.EventId <= eventCursor) return null;
                if (!string.Equals(_lastEvent.PolicyCategory, "retryable_error", StringComparison.OrdinalIgnoreCase)) return null;
                if (string.IsNullOrWhiteSpace(_lastEvent.MatchedGuardId)) return null;
                if (!string.Equals(_lastEvent.ActionStatus, "clicked", StringComparison.OrdinalIgnoreCase)) return null;
                if (!_lastEvent.ResolvedAtUtc.HasValue) return null;

                return new ResolvedDialogRecovery
                {
                    EventId = _lastEvent.EventId,
                    CapturedAtUtc = _lastEvent.CapturedAtUtc,
                    DialogId = _lastEvent.DialogId,
                    PolicyCategory = _lastEvent.PolicyCategory ?? "retryable_error",
                    PolicyAction = _lastEvent.PolicyAction,
                    MatchedGuardId = _lastEvent.MatchedGuardId,
                    ClickedButton = _lastEvent.ClickedButton,
                    ScreenshotPath = _lastEvent.ScreenshotPath,
                    ResolvedAtUtc = _lastEvent.ResolvedAtUtc.Value
                };
            }
        }

        public object? GetLastDialogEventSummary()
        {
            var last = GetLastEventSnapshot();
            if (last == null) return null;

            return new
            {
                event_id = last.EventId.ToString(CultureInfo.InvariantCulture),
                captured_at = last.CapturedAtUtc.ToString("o"),
                event_type = last.EventType,
                dialog_id = last.DialogId,
                message = last.Message,
                matched_guard_id = last.MatchedGuardId,
                action_status = last.ActionStatus,
                action_error = last.ActionError,
                clicked_button = last.ClickedButton,
                screenshot_path = last.ScreenshotPath,
                resolved_at = last.ResolvedAtUtc?.ToString("o")
            };
        }

        private static object ToWireDialog(DialogWindowSnapshot dialog)
        {
            return new
            {
                hwnd = FormatHandle(dialog.Hwnd),
                title = dialog.Title,
                class_name = dialog.ClassName,
                is_modal = dialog.IsModal,
                is_top_most = dialog.IsTopMost,
                owner_main_window = dialog.OwnerMainWindow,
                default_button = dialog.DefaultButton,
                buttons = dialog.Buttons.Select(x => x.Label).ToList()
            };
        }

        private List<DialogWindowSnapshot> EnumerateDialogs(int maxItems, bool onlyModal)
        {
            var windows = new List<DialogWindowSnapshot>();
            var mainHandle = Process.GetCurrentProcess().MainWindowHandle;
            var pid = Process.GetCurrentProcess().Id;
            var foreground = GetForegroundWindow();

            EnumWindows((hWnd, _) =>
            {
                if (windows.Count >= maxItems) return false;
                if (hWnd == IntPtr.Zero || hWnd == mainHandle || !IsWindowVisible(hWnd)) return true;

                GetWindowThreadProcessId(hWnd, out var ownerPid);
                if (ownerPid != pid) return true;

                var className = ReadClassName(hWnd);
                var title = ReadWindowText(hWnd);
                var owner = GetWindow(hWnd, GW_OWNER);
                var classIsDialog = string.Equals(className, "#32770", StringComparison.OrdinalIgnoreCase);
                var ownedByMain = owner == mainHandle;
                if (!classIsDialog && !ownedByMain) return true;

                var buttons = ReadButtons(hWnd);
                if (string.IsNullOrWhiteSpace(title) && buttons.Count == 0) return true;

                var isModal = (ownedByMain && mainHandle != IntPtr.Zero && !IsWindowEnabled(mainHandle)) || classIsDialog;
                if (onlyModal && !isModal) return true;

                windows.Add(new DialogWindowSnapshot
                {
                    Hwnd = hWnd,
                    Title = title,
                    ClassName = className,
                    IsModal = isModal,
                    IsTopMost = hWnd == foreground,
                    OwnerMainWindow = ownedByMain,
                    DefaultButton = buttons.FirstOrDefault(x => x.IsDefault)?.Label ?? buttons.FirstOrDefault()?.Label,
                    Buttons = buttons
                });
                return true;
            }, IntPtr.Zero);

            return windows
                .OrderByDescending(x => x.IsTopMost)
                .ThenByDescending(x => x.IsModal)
                .ThenBy(x => x.Title, StringComparer.OrdinalIgnoreCase)
                .ToList();
        }

        private static List<DialogButtonSnapshot> ReadButtons(IntPtr dialogHwnd)
        {
            var buttons = new List<DialogButtonSnapshot>();
            EnumChildWindows(dialogHwnd, (child, _) =>
            {
                if (!string.Equals(ReadClassName(child), "Button", StringComparison.OrdinalIgnoreCase)) return true;
                var label = ReadWindowText(child);
                if (string.IsNullOrWhiteSpace(label)) return true;
                if (buttons.Any(x => LabelEquals(x.Label, label))) return true;
                var style = GetWindowLongPtrCompat(child, GWL_STYLE).ToInt64();
                buttons.Add(new DialogButtonSnapshot
                {
                    Hwnd = child,
                    Label = label,
                    IsDefault = (style & BS_DEFPUSHBUTTON) != 0
                });
                return true;
            }, IntPtr.Zero);
            return buttons;
        }

        private string CaptureDialogScreenshot(IntPtr hWnd, int maxSidePx, string suffix)
        {
            if (hWnd == IntPtr.Zero) throw new InvalidOperationException("Dialog handle is required.");
            if (!GetWindowRect(hWnd, out var rect)) throw new InvalidOperationException("GetWindowRect failed.");
            var width = Math.Max(1, rect.Right - rect.Left);
            var height = Math.Max(1, rect.Bottom - rect.Top);
            if (width < 8 || height < 8) throw new InvalidOperationException("Dialog bounds are not usable.");

            using var bmp = new Bitmap(width, height, PixelFormat.Format24bppRgb);
            using (var g = Graphics.FromImage(bmp))
            {
                g.CopyFromScreen(rect.Left, rect.Top, 0, 0, new Size(width, height), CopyPixelOperation.SourceCopy);
            }

            using var final = DownscaleIfNeeded(bmp, maxSidePx);
            var stamp = DateTime.Now.ToString("yyyyMMdd_HHmmss_fff", CultureInfo.InvariantCulture);
            var dir = WorkspacePaths.EnsureDir("artifacts", "dialog-computer-use");
            var fileName = $"dialog_{stamp}_{SanitizeFileSegment(suffix)}.jpg";
            var fullPath = Path.Combine(dir, fileName);
            SaveJpeg(fullPath, final, 85L);
            return fullPath;
        }

        private void CleanupExpiredGuards_NoLock()
        {
            var now = DateTime.UtcNow;
            _guards.RemoveAll(x => x.ExpiresAtUtc <= now || x.TriggerCount >= x.MaxTriggers);
        }

        private static bool ButtonTokenMatchesLabel(string? tokenRaw, string? labelRaw)
        {
            var token = NormalizeToken(tokenRaw);
            var label = NormalizeToken(labelRaw);
            if (string.IsNullOrWhiteSpace(token) || string.IsNullOrWhiteSpace(label)) return false;
            if (string.Equals(token, label, StringComparison.Ordinal)) return true;

            switch (token)
            {
                case "ok":
                    return label == "ok" || label == "okay";
                case "close":
                    return label == "close";
                case "yes":
                    return label == "yes";
                case "no":
                    return label == "no";
                case "cancel":
                    return label == "cancel";
                case "retry":
                    return label == "retry";
                case "continue":
                    return label == "continue";
                default:
                    return label.IndexOf(token, StringComparison.Ordinal) >= 0;
            }
        }

        private static bool ContainsNormalized(string? sourceRaw, string? tokenRaw)
        {
            var source = NormalizeToken(sourceRaw);
            var token = NormalizeToken(tokenRaw);
            if (string.IsNullOrWhiteSpace(source) || string.IsNullOrWhiteSpace(token)) return false;
            return source.IndexOf(token, StringComparison.Ordinal) >= 0;
        }

        private static bool LabelEquals(string? a, string? b)
        {
            return string.Equals(NormalizeToken(a), NormalizeToken(b), StringComparison.Ordinal);
        }

        private static string? NormalizeToken(string? value)
        {
            if (string.IsNullOrWhiteSpace(value)) return null;
            var s = value.Trim().Replace("&", string.Empty);
            while (s.IndexOf("  ", StringComparison.Ordinal) >= 0) s = s.Replace("  ", " ");
            return s.ToLowerInvariant();
        }

        private static string TryReadStringProperty(object? source, string propertyName)
        {
            try
            {
                var prop = source?.GetType().GetProperty(propertyName);
                var value = prop?.GetValue(source);
                return value?.ToString() ?? string.Empty;
            }
            catch
            {
                return string.Empty;
            }
        }

        private static string FormatHandle(IntPtr hWnd)
        {
            return hWnd == IntPtr.Zero ? "0x0" : "0x" + hWnd.ToInt64().ToString("X", CultureInfo.InvariantCulture);
        }

        private static string SanitizeFileSegment(string value)
        {
            var raw = (value ?? "dialog").Trim();
            if (raw.Length == 0) raw = "dialog";
            var sb = new StringBuilder(raw.Length);
            foreach (var ch in raw)
            {
                if (char.IsLetterOrDigit(ch)) sb.Append(char.ToLowerInvariant(ch));
                else if (ch == '-' || ch == '_') sb.Append(ch);
                else sb.Append('_');
            }
            var outValue = sb.ToString().Trim('_');
            return outValue.Length == 0 ? "dialog" : outValue;
        }

        private static T? Safe<T>(Func<T> getter)
        {
            try { return getter(); }
            catch { return default; }
        }

        private static int Clamp(int value, int min, int max)
        {
            return value < min ? min : (value > max ? max : value);
        }

        private static Bitmap DownscaleIfNeeded(Bitmap src, int maxSidePx)
        {
            if (maxSidePx <= 0) return (Bitmap)src.Clone();
            var max = Math.Max(src.Width, src.Height);
            if (max <= maxSidePx) return (Bitmap)src.Clone();
            var scale = (double)maxSidePx / (double)max;
            var width = Math.Max(1, (int)Math.Round(src.Width * scale));
            var height = Math.Max(1, (int)Math.Round(src.Height * scale));
            var dst = new Bitmap(width, height, PixelFormat.Format24bppRgb);
            using (var g = Graphics.FromImage(dst))
            {
                g.InterpolationMode = System.Drawing.Drawing2D.InterpolationMode.HighQualityBicubic;
                g.SmoothingMode = System.Drawing.Drawing2D.SmoothingMode.HighQuality;
                g.PixelOffsetMode = System.Drawing.Drawing2D.PixelOffsetMode.HighQuality;
                g.DrawImage(src, 0, 0, width, height);
            }
            return dst;
        }

        private static void SaveJpeg(string fullPath, Bitmap bitmap, long quality)
        {
            Directory.CreateDirectory(Path.GetDirectoryName(fullPath) ?? WorkspacePaths.EnsureDir("artifacts", "dialog-computer-use"));
            var codec = ImageCodecInfo.GetImageEncoders().FirstOrDefault(x => x != null && x.MimeType == "image/jpeg");
            if (codec == null)
            {
                bitmap.Save(fullPath, ImageFormat.Jpeg);
                return;
            }

            using var encoder = new EncoderParameters(1);
            encoder.Param[0] = new EncoderParameter(System.Drawing.Imaging.Encoder.Quality, Math.Max(10L, Math.Min(100L, quality)));
            bitmap.Save(fullPath, codec, encoder);
        }

        internal sealed class ResolvedDialogRecovery
        {
            public long EventId { get; set; }
            public DateTime CapturedAtUtc { get; set; }
            public string DialogId { get; set; } = string.Empty;
            public string PolicyCategory { get; set; } = string.Empty;
            public string? PolicyAction { get; set; }
            public string? MatchedGuardId { get; set; }
            public string? ClickedButton { get; set; }
            public string? ScreenshotPath { get; set; }
            public DateTime ResolvedAtUtc { get; set; }

            public object ToReceipt()
            {
                return new
                {
                    event_id = EventId.ToString(CultureInfo.InvariantCulture),
                    captured_at = CapturedAtUtc.ToString("o"),
                    dialog_id = DialogId,
                    policy_category = PolicyCategory,
                    selected_action = PolicyAction,
                    matched_guard_id = MatchedGuardId,
                    clicked_button = ClickedButton,
                    screenshot_path = ScreenshotPath,
                    resolved_at = ResolvedAtUtc.ToString("o")
                };
            }
        }

        private sealed class DialogEventRecord
        {
            public long EventId { get; set; }
            public DateTime CapturedAtUtc { get; set; }
            public string EventType { get; set; } = string.Empty;
            public string DialogId { get; set; } = string.Empty;
            public string Message { get; set; } = string.Empty;
            public string? PolicyCategory { get; set; }
            public string? PolicyAction { get; set; }
            public string? MatchedGuardId { get; set; }
            public string? ActionStatus { get; set; }
            public string? ActionError { get; set; }
            public string? ClickedButton { get; set; }
            public string? ScreenshotPath { get; set; }
            public DateTime? ResolvedAtUtc { get; set; }

            public DialogEventRecord Clone()
            {
                return (DialogEventRecord)MemberwiseClone();
            }
        }

        private sealed class DialogPolicyDecision
        {
            public DialogPolicyDecision(string category, string action)
            {
                Category = category;
                Action = action;
            }

            public string Category { get; }
            public string Action { get; }
        }

        private sealed class DialogGuardRule
        {
            public long GuardId { get; set; }
            public DateTime CreatedAtUtc { get; set; }
            public DateTime ExpiresAtUtc { get; set; }
            public int MaxTriggers { get; set; }
            public int TriggerCount { get; set; }
            public string? TitleContains { get; set; }
            public string? DialogIdContains { get; set; }
            public string? MessageContains { get; set; }
            public ButtonSelection Selection { get; set; } = ButtonSelection.Default();
            public InteractionModeSelection InteractionMode { get; set; } = new InteractionModeSelection();
            public CursorRestoreSelection CursorRestoreMode { get; set; } = new CursorRestoreSelection();
            public bool IncludeScreenshotAfter { get; set; }
            public int ScreenshotMaxSidePx { get; set; }

            public bool CanTrigger(DialogEventRecord record)
            {
                if (record == null) return false;
                if (ExpiresAtUtc <= DateTime.UtcNow) return false;
                if (!string.IsNullOrWhiteSpace(DialogIdContains) && !ContainsNormalized(record.DialogId, DialogIdContains)) return false;
                if (!string.IsNullOrWhiteSpace(MessageContains) && !ContainsNormalized(record.Message, MessageContains)) return false;
                return true;
            }

            public DialogGuardRule Clone()
            {
                return new DialogGuardRule
                {
                    GuardId = GuardId,
                    CreatedAtUtc = CreatedAtUtc,
                    ExpiresAtUtc = ExpiresAtUtc,
                    MaxTriggers = MaxTriggers,
                    TriggerCount = TriggerCount,
                    TitleContains = TitleContains,
                    DialogIdContains = DialogIdContains,
                    MessageContains = MessageContains,
                    Selection = Selection.Clone(),
                    InteractionMode = new InteractionModeSelection { Mode = InteractionMode.Mode },
                    CursorRestoreMode = CursorRestoreMode.Clone(),
                    IncludeScreenshotAfter = IncludeScreenshotAfter,
                    ScreenshotMaxSidePx = ScreenshotMaxSidePx
                };
            }
        }

        private sealed class DialogWindowSnapshot
        {
            public IntPtr Hwnd { get; set; }
            public string Title { get; set; } = string.Empty;
            public string ClassName { get; set; } = string.Empty;
            public bool IsModal { get; set; }
            public bool IsTopMost { get; set; }
            public bool OwnerMainWindow { get; set; }
            public string? DefaultButton { get; set; }
            public List<DialogButtonSnapshot> Buttons { get; set; } = new List<DialogButtonSnapshot>();
        }

        private sealed class DialogButtonSnapshot
        {
            public IntPtr Hwnd { get; set; }
            public string Label { get; set; } = string.Empty;
            public bool IsDefault { get; set; }
        }

        private sealed class ButtonActionResult
        {
            public bool Clicked { get; set; }
            public string? DialogTitle { get; set; }
            public string? DialogHandle { get; set; }
            public string? ClickedButton { get; set; }
            public string? ClickMethod { get; set; }
            public bool MessageClickAttempted { get; set; }
            public bool MouseFallbackUsed { get; set; }
            public string? MouseFallbackReason { get; set; }
            public bool? CursorRestored { get; set; }
            public string? CursorRestoreError { get; set; }
            public string? ScreenshotPath { get; set; }
            public string? Error { get; set; }
        }

        private enum InteractionMode
        {
            Message,
            Mouse,
            MessageThenMouse
        }

        private sealed class InteractionModeSelection
        {
            public InteractionMode Mode { get; set; } = InteractionMode.MessageThenMouse;

            public static InteractionModeSelection From(string? raw)
            {
                var value = NormalizeToken(raw)?.Replace("-", "_") ?? "message_then_mouse";
                if (value == "message") return new InteractionModeSelection { Mode = InteractionMode.Message };
                if (value == "mouse") return new InteractionModeSelection { Mode = InteractionMode.Mouse };
                return new InteractionModeSelection { Mode = InteractionMode.MessageThenMouse };
            }

            public string Describe()
            {
                return Mode == InteractionMode.Message ? "message" :
                    Mode == InteractionMode.Mouse ? "mouse" :
                    "message_then_mouse";
            }
        }

        private sealed class CursorRestoreSelection
        {
            public bool Restore { get; set; } = true;

            public static CursorRestoreSelection From(string? raw)
            {
                var value = NormalizeToken(raw)?.Replace("-", "_") ?? "keep";
                return new CursorRestoreSelection
                {
                    Restore = value == "restore"
                };
            }

            public string Describe()
            {
                return Restore ? "restore" : "keep";
            }

            public CursorRestoreSelection Clone()
            {
                return new CursorRestoreSelection { Restore = Restore };
            }
        }

        private sealed class ButtonSelection
        {
            public string? ButtonToken { get; set; }
            public string? ButtonText { get; set; }
            public int? ButtonIndex { get; set; }

            public bool IsEmpty => string.IsNullOrWhiteSpace(ButtonToken) && string.IsNullOrWhiteSpace(ButtonText) && !ButtonIndex.HasValue;

            public static ButtonSelection Default()
            {
                return new ButtonSelection { ButtonToken = "default" };
            }

            public static ButtonSelection From(string? button, string? buttonText, int? buttonIndex)
            {
                return new ButtonSelection
                {
                    ButtonToken = NormalizeToken(button),
                    ButtonText = buttonText,
                    ButtonIndex = buttonIndex
                };
            }

            public string Describe()
            {
                if (!string.IsNullOrWhiteSpace(ButtonText)) return $"text:{ButtonText}";
                if (ButtonIndex.HasValue) return $"index:{ButtonIndex.Value.ToString(CultureInfo.InvariantCulture)}";
                return ButtonToken ?? "default";
            }

            public ButtonSelection Clone()
            {
                return new ButtonSelection
                {
                    ButtonToken = ButtonToken,
                    ButtonText = ButtonText,
                    ButtonIndex = ButtonIndex
                };
            }
        }

        public sealed class ObserveParams
        {
            public bool? includeScreenshot { get; set; }
            public int? screenshotMaxSidePx { get; set; }
            public int? maxDialogs { get; set; }
            public bool? onlyModal { get; set; }
            public string? titleContains { get; set; }
            public string? dialogIdContains { get; set; }
        }

        public sealed class ActParams
        {
            public string? button { get; set; }
            public string? buttonText { get; set; }
            public int? buttonIndex { get; set; }
            public string? interactionMode { get; set; }
            public string? cursorRestoreMode { get; set; }
            public string? titleContains { get; set; }
            public string? dialogIdContains { get; set; }
            public bool? includeScreenshotAfter { get; set; }
            public int? screenshotMaxSidePx { get; set; }
            public int? waitForDialogMs { get; set; }
        }

        public sealed class GuardParams
        {
            public string? button { get; set; }
            public string? buttonText { get; set; }
            public int? buttonIndex { get; set; }
            public string? interactionMode { get; set; }
            public string? cursorRestoreMode { get; set; }
            public string? titleContains { get; set; }
            public string? dialogIdContains { get; set; }
            public string? messageContains { get; set; }
            public int? maxTriggers { get; set; }
            public int? ttlMs { get; set; }
            public bool? includeScreenshotAfter { get; set; }
            public int? screenshotMaxSidePx { get; set; }
        }

        private delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

        [StructLayout(LayoutKind.Sequential)]
        private struct POINT
        {
            public int X;
            public int Y;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct RECT
        {
            public int Left;
            public int Top;
            public int Right;
            public int Bottom;
        }

        [DllImport("user32.dll")] private static extern bool EnumWindows(EnumWindowsProc cb, IntPtr lParam);
        [DllImport("user32.dll")] private static extern bool EnumChildWindows(IntPtr hWndParent, EnumWindowsProc cb, IntPtr lParam);
        [DllImport("user32.dll")] private static extern bool IsWindowVisible(IntPtr hWnd);
        [DllImport("user32.dll")] private static extern bool IsWindowEnabled(IntPtr hWnd);
        [DllImport("user32.dll")] private static extern IntPtr GetWindow(IntPtr hWnd, uint cmd);
        [DllImport("user32.dll")] private static extern IntPtr GetForegroundWindow();
        [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr hWnd, out int processId);
        [DllImport("user32.dll", SetLastError = true)] private static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int maxCount);
        [DllImport("user32.dll", SetLastError = true)] private static extern int GetWindowTextLength(IntPtr hWnd);
        [DllImport("user32.dll", SetLastError = true)] private static extern int GetClassName(IntPtr hWnd, StringBuilder className, int maxCount);
        [DllImport("user32.dll")] private static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
        [DllImport("user32.dll")] private static extern bool GetCursorPos(out POINT lpPoint);
        [DllImport("user32.dll")] private static extern bool SetCursorPos(int X, int Y);
        [DllImport("user32.dll")] private static extern void mouse_event(uint dwFlags, uint dx, uint dy, uint dwData, UIntPtr dwExtraInfo);
        [DllImport("user32.dll")] private static extern IntPtr SendMessage(IntPtr hWnd, int msg, IntPtr wParam, IntPtr lParam);
        [DllImport("user32.dll")] private static extern bool SetForegroundWindow(IntPtr hWnd);
        [DllImport("user32.dll", EntryPoint = "GetWindowLong")] private static extern int GetWindowLong32(IntPtr hWnd, int nIndex);
        [DllImport("user32.dll", EntryPoint = "GetWindowLongPtr")] private static extern IntPtr GetWindowLongPtr64(IntPtr hWnd, int nIndex);

        private static IntPtr GetWindowLongPtrCompat(IntPtr hWnd, int nIndex)
        {
            return IntPtr.Size == 8 ? GetWindowLongPtr64(hWnd, nIndex) : new IntPtr(GetWindowLong32(hWnd, nIndex));
        }

        private static string ReadWindowText(IntPtr hWnd)
        {
            var len = GetWindowTextLength(hWnd);
            if (len <= 0) return string.Empty;
            var sb = new StringBuilder(len + 2);
            _ = GetWindowText(hWnd, sb, sb.Capacity);
            return sb.ToString().Trim();
        }

        private static string ReadClassName(IntPtr hWnd)
        {
            var sb = new StringBuilder(256);
            var len = GetClassName(hWnd, sb, sb.Capacity);
            return len <= 0 ? string.Empty : sb.ToString().Trim();
        }
    }
}
