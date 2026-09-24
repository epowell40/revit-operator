using System;
using System.IO;
using System.Linq;
using Xunit;

namespace RevitBridge.Common.Tests
{
    public sealed class OperatorDialogLifecycleContractTests
    {
        [Fact]
        public void DialogHookIsScopedToAnActiveGuardInsteadOfRevitStartup()
        {
            var source = ReadRepoFile(
                "apps", "revit-bridge-addin", "RevitBridge", "Operator", "OperatorDialogComputerUse.cs");

            var constructor = Slice(source, "public OperatorDialogComputerUse(", "public object Observe(");
            Assert.DoesNotContain("DialogBoxShowing +=", constructor);

            var armGuard = Slice(source, "public object ArmGuard(", "public void Dispose()");
            Assert.Contains("_guards.Add(guard);", armGuard);
            Assert.Contains("UpdateDialogEventSubscription_NoLock();", armGuard);

            var subscription = Slice(source, "private void UpdateDialogEventSubscription_NoLock()", "private static bool ButtonTokenMatchesLabel(");
            Assert.Contains("var shouldSubscribe = _guards.Count > 0;", subscription);
            Assert.Contains("_application.DialogBoxShowing += OnDialogBoxShowing;", subscription);
            Assert.Contains("_application.DialogBoxShowing -= OnDialogBoxShowing;", subscription);
        }

        [Fact]
        public void HttpGuardCanArmFromTransportThreadOnlyAfterEnteringRevitDispatcher()
        {
            var guard = ReadRepoFile("apps", "revit-bridge-addin", "RevitBridge", "Operator", "OperatorDialogComputerUse.cs");
            var arm = Slice(guard, "public object ArmGuard(", "public void Dispose()");
            Assert.Contains("if (!_dispatcher.CheckAccess())", arm);
            Assert.Contains("_dispatcher.Invoke(() => ArmGuard(request))", arm);
            Assert.True(arm.IndexOf("_dispatcher.Invoke(() => ArmGuard(request))", StringComparison.Ordinal)
                < arm.IndexOf("_guards.Add(guard);", StringComparison.Ordinal));

            var server = ReadRepoFile("apps", "revit-bridge-addin", "RevitBridge", "Server", "RevitHttpServer.cs");
            Assert.Contains("IsDirectDialogComputerUsePath(path)", server);
            Assert.Contains("\"/revit/computer-use-guard\"", server);
        }

        [Fact]
        public void CourierRetryGuardAlsoUsesSameDispatcherBoundaryAndCanDisarmSafely()
        {
            var guard = ReadRepoFile("apps", "revit-bridge-addin", "RevitBridge", "Operator", "OperatorDialogComputerUse.cs");
            var retry = Slice(guard, "internal string? ArmRetryableWarningCancelGuard()", "internal ResolvedDialogRecovery?");
            Assert.Contains("ArmGuard(new GuardParams", retry);
            Assert.Contains("_dispatcher.Invoke(() => DisarmGuard(guardId))", retry);

            var runner = ReadRepoFile("apps", "revit-bridge-addin", "RevitBridge", "Operator", "OperatorActionRunner.cs");
            Assert.Contains("dialogComputerUse!.ArmRetryableWarningCancelGuard()", runner);
        }

        private static string Slice(string source, string start, string end)
        {
            var startIndex = source.IndexOf(start, StringComparison.Ordinal);
            Assert.True(startIndex >= 0, $"Missing source marker: {start}");
            var endIndex = source.IndexOf(end, startIndex + start.Length, StringComparison.Ordinal);
            Assert.True(endIndex > startIndex, $"Missing source marker: {end}");
            return source.Substring(startIndex, endIndex - startIndex);
        }

        private static string ReadRepoFile(params string[] relativeSegments)
        {
            var cursor = new DirectoryInfo(AppContext.BaseDirectory);
            while (cursor != null)
            {
                var candidate = Path.Combine(new[] { cursor.FullName }.Concat(relativeSegments).ToArray());
                if (File.Exists(candidate)) return File.ReadAllText(candidate);
                cursor = cursor.Parent;
            }

            throw new FileNotFoundException("Could not locate repository source file.", Path.Combine(relativeSegments));
        }
    }
}
