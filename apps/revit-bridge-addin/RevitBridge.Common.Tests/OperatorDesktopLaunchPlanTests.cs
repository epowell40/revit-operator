using System;
using System.Collections.Generic;
using RevitBridge.Common;
using Xunit;

namespace RevitBridge.Common.Tests
{
    public sealed class OperatorDesktopLaunchPlanTests
    {
        [Fact]
        public void BuildCandidatePaths_PrefersConfiguredThenInstalledLaunchers()
        {
            var candidates = OperatorDesktopLaunchPlan.BuildCandidatePaths(
                @"C:\Custom\launch.cmd",
                @"C:\Users\Tester\AppData\Local",
                @"C:\Users\Tester\Desktop",
                @"C:\Repo\revit-bridge-addin\RevitBridge\bin\Release");

            Assert.Equal(@"C:\Custom\launch.cmd", candidates[0]);
            Assert.Equal(
                @"C:\Users\Tester\AppData\Local\RevitOperator\Operator Desktop.cmd",
                candidates[1]);
            Assert.Equal(@"C:\Users\Tester\Desktop\Operator Desktop.cmd", candidates[2]);
            Assert.Equal(@"C:\Users\Tester\Desktop\Operator Desktop.lnk", candidates[3]);
        }

        [Fact]
        public void BuildCandidatePaths_FindsRepositoryLauncherFromBuildDirectory()
        {
            var candidates = OperatorDesktopLaunchPlan.BuildCandidatePaths(
                null,
                @"C:\Local",
                @"C:\Desktop",
                @"C:\Repo\revit-bridge-addin\RevitBridge\bin\x64\Release\net48\win-x64");

            Assert.Contains(
                @"C:\Repo\operator-desktop\scripts\launch_operator_desktop.cmd",
                candidates,
                StringComparer.OrdinalIgnoreCase);
        }

        [Fact]
        public void ResolveExistingLauncher_UsesFirstExistingCandidate()
        {
            var candidates = new[] { @"C:\missing.cmd", @"C:\installed.cmd", @"C:\later.cmd" };
            var existing = new HashSet<string>(StringComparer.OrdinalIgnoreCase)
            {
                @"C:\installed.cmd",
                @"C:\later.cmd"
            };

            var resolved = OperatorDesktopLaunchPlan.ResolveExistingLauncher(candidates, existing.Contains);

            Assert.Equal(@"C:\installed.cmd", resolved);
        }

        [Fact]
        public void ResolveExistingLauncher_ReturnsNullWhenNoCandidateExists()
        {
            var resolved = OperatorDesktopLaunchPlan.ResolveExistingLauncher(
                new[] { @"C:\missing.cmd" },
                _ => false);

            Assert.Null(resolved);
        }
    }
}
