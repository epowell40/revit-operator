using System;
using System.Collections.Generic;
using System.Collections.ObjectModel;
using System.ComponentModel;
using System.Runtime.CompilerServices;
using System.Text.Json;
using System.Windows;
using System.Windows.Controls;

namespace RevitBridge.Operator
{
    internal sealed class OperatorFallbackControl : UserControl
    {
        public sealed class ChatSendEventArgs : EventArgs
        {
            public ChatSendEventArgs(string messageId, string text, List<OperatorUserAttachment> attachments)
            {
                MessageId = messageId;
                Text = text;
                Attachments = attachments;
            }

            public string MessageId { get; }
            public string Text { get; }
            public List<OperatorUserAttachment> Attachments { get; }
        }

        private sealed class ActionRow : INotifyPropertyChanged
        {
            public string ActionId { get; set; } = "";
            public string Title { get; set; } = "";
            public string Path { get; set; } = "";

            private string _status = "pending";
            public string Status
            {
                get => _status;
                set { _status = value; OnPropertyChanged(); OnPropertyChanged(nameof(Display)); }
            }

            private string? _error;
            public string? Error
            {
                get => _error;
                set { _error = value; OnPropertyChanged(); OnPropertyChanged(nameof(Display)); }
            }

            private string? _resultJson;
            public string? ResultJson
            {
                get => _resultJson;
                set { _resultJson = value; OnPropertyChanged(); OnPropertyChanged(nameof(Display)); }
            }

            public string Display
            {
                get
                {
                    var suffix = string.IsNullOrWhiteSpace(Error) ? "" : $" ERROR: {Error}";
                    var result = string.IsNullOrWhiteSpace(ResultJson) ? "" : $" RESULT: {ResultJson}";
                    return $"{Status} {Path}{suffix}{result}";
                }
            }

            public event PropertyChangedEventHandler? PropertyChanged;

            private void OnPropertyChanged([CallerMemberName] string? name = null)
            {
                PropertyChanged?.Invoke(this, new PropertyChangedEventArgs(name));
            }
        }

        private readonly ObservableCollection<string> _transcript = new ObservableCollection<string>();
        private readonly ObservableCollection<ActionRow> _actions = new ObservableCollection<ActionRow>();
        private readonly Dictionary<string, ActionRow> _actionIndex = new Dictionary<string, ActionRow>(StringComparer.OrdinalIgnoreCase);

        public event EventHandler<ChatSendEventArgs>? ChatSend;
        public event EventHandler? AttachmentRequested;
        public event EventHandler? NewChatRequested;
        public event EventHandler? CancelRequested;

        private readonly TextBox _input;
        private readonly Button _cancel;
        private readonly Button _attach;
        private readonly Button _send;
        private readonly Button _newChat;
        private readonly List<OperatorUserAttachment> _pendingAttachments = new List<OperatorUserAttachment>();

        public OperatorFallbackControl()
        {
            var root = new Grid();
            root.RowDefinitions.Add(new RowDefinition { Height = new GridLength(1, GridUnitType.Star) });
            root.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });
            root.RowDefinitions.Add(new RowDefinition { Height = new GridLength(220) });
            root.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });

            var transcript = new ListBox { ItemsSource = _transcript };
            Grid.SetRow(transcript, 0);
            root.Children.Add(transcript);

            var splitter = new GridSplitter
            {
                Height = 6,
                HorizontalAlignment = HorizontalAlignment.Stretch,
                VerticalAlignment = VerticalAlignment.Center,
                Background = System.Windows.Media.Brushes.Transparent
            };
            Grid.SetRow(splitter, 1);
            root.Children.Add(splitter);

            var actions = new ListBox { ItemsSource = _actions, DisplayMemberPath = nameof(ActionRow.Display) };
            Grid.SetRow(actions, 2);
            root.Children.Add(actions);

            var inputRow = new Grid { Margin = new Thickness(6) };
            inputRow.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
            inputRow.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
            inputRow.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
            inputRow.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
            inputRow.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });

            _input = new TextBox
            {
                Margin = new Thickness(0, 0, 6, 0),
                MinHeight = 52,
                AcceptsReturn = true,
                TextWrapping = TextWrapping.Wrap,
                VerticalScrollBarVisibility = ScrollBarVisibility.Auto
            };
            _input.KeyDown += (_, e) =>
            {
                if (e.Key == System.Windows.Input.Key.Enter)
                {
                    var shift = (System.Windows.Input.Keyboard.Modifiers & System.Windows.Input.ModifierKeys.Shift) != 0;
                    if (!shift)
                    {
                        e.Handled = true;
                        Send();
                    }
                }
            };

            _cancel = new Button { Content = "Cancel", MinHeight = 28, MinWidth = 64, Margin = new Thickness(0, 0, 6, 0) };
            _cancel.Click += (_, __) => CancelRequested?.Invoke(this, EventArgs.Empty);

            _attach = new Button { Content = "Attach…", MinHeight = 28, MinWidth = 72, Margin = new Thickness(0, 0, 6, 0) };
            _attach.Click += (_, __) => AttachmentRequested?.Invoke(this, EventArgs.Empty);

            _send = new Button { Content = "Send", MinHeight = 28, MinWidth = 64 };
            _send.Click += (_, __) => Send();

            _newChat = new Button { Content = "New chat", MinHeight = 28, MinWidth = 76, Margin = new Thickness(6, 0, 0, 0) };
            _newChat.Click += (_, __) => NewChatRequested?.Invoke(this, EventArgs.Empty);

            Grid.SetColumn(_input, 0);
            Grid.SetColumn(_cancel, 1);
            Grid.SetColumn(_attach, 2);
            Grid.SetColumn(_send, 3);
            Grid.SetColumn(_newChat, 4);
            inputRow.Children.Add(_input);
            inputRow.Children.Add(_cancel);
            inputRow.Children.Add(_attach);
            inputRow.Children.Add(_send);
            inputRow.Children.Add(_newChat);

            Grid.SetRow(inputRow, 3);
            root.Children.Add(inputRow);

            Content = root;

            AppendChat("system", "WebView2 not available; using WPF fallback UI.");
        }

        private void Send()
        {
            var text = (_input.Text ?? "").Trim();
            if (string.IsNullOrWhiteSpace(text) && _pendingAttachments.Count == 0) return;
            var attachments = new List<OperatorUserAttachment>(_pendingAttachments);
            _input.Text = "";
            _pendingAttachments.Clear();
            RefreshAttachmentLabel();
            ChatSend?.Invoke(this, new ChatSendEventArgs(Guid.NewGuid().ToString("N"), text, attachments));
        }

        public void AddAttachments(IEnumerable<OperatorUserAttachment> attachments)
        {
            if (attachments == null) return;
            foreach (var attachment in attachments)
            {
                if (attachment == null) continue;
                if (_pendingAttachments.Exists(existing => string.Equals(existing.Id, attachment.Id, StringComparison.OrdinalIgnoreCase))) continue;
                _pendingAttachments.Add(attachment);
            }
            RefreshAttachmentLabel();
        }

        private void RefreshAttachmentLabel()
        {
            _attach.Content = _pendingAttachments.Count == 0 ? "Attach…" : $"Attach ({_pendingAttachments.Count})";
        }

        public void AppendChat(string role, string text)
        {
            var r = (role ?? "").Trim();
            if (string.Equals(r, "assistant", StringComparison.OrdinalIgnoreCase)) r = "Operator";
            else if (string.Equals(r, "system", StringComparison.OrdinalIgnoreCase)) r = "System";
            else if (string.Equals(r, "user", StringComparison.OrdinalIgnoreCase)) r = "User";
            _transcript.Add($"[{r}] {text}");
        }

        public void AddAction(string actionId, string title, string path, object? body)
        {
            if (_actionIndex.ContainsKey(actionId)) return;

            var row = new ActionRow
            {
                ActionId = actionId,
                Title = title,
                Path = path,
                Status = "pending",
                ResultJson = body == null ? null : JsonSerializer.Serialize(body, OperatorUiProtocol.JsonOptions)
            };
            _actionIndex[actionId] = row;
            _actions.Add(row);
        }

        public void UpdateActionStatus(string actionId, string status, string? error)
        {
            if (!_actionIndex.TryGetValue(actionId, out var row)) return;
            row.Status = status;
            row.Error = error;
        }

        public void SetActionResult(string actionId, object? resultJson)
        {
            if (!_actionIndex.TryGetValue(actionId, out var row)) return;
            row.ResultJson = resultJson == null ? null : JsonSerializer.Serialize(resultJson, OperatorUiProtocol.JsonOptions);
        }

        public void ResetUi()
        {
            _transcript.Clear();
            _actions.Clear();
            _actionIndex.Clear();
            _pendingAttachments.Clear();
            RefreshAttachmentLabel();
            _input.Focus();
        }
    }
}
