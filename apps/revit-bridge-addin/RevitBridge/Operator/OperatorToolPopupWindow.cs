using System;
using System.Windows;
using Microsoft.Web.WebView2.Wpf;

namespace RevitBridge.Operator
{
    internal sealed class OperatorToolPopupWindow : Window
    {
        public OperatorToolPopupWindow(string title, int width, int height, Action? onClosed)
        {
            Title = string.IsNullOrWhiteSpace(title) ? "Tool UI" : title;
            Width = width;
            Height = height;
            MinWidth = 480;
            MinHeight = 360;
            WindowStartupLocation = WindowStartupLocation.CenterScreen;
            Browser = new WebView2();
            Content = Browser;
            Closed += (_, __) => onClosed?.Invoke();
        }

        public WebView2 Browser { get; }
    }
}
