using System;
using System.IO;
using System.Linq;
using Xunit;

namespace RevitBridge.Common.Tests
{
    public sealed class OperatorUnifiedAgentSettingsContractTests
    {
        [Fact]
        public void OperatorUiSendsOneModelAndOneReasoningEffortForTheWholeAgentTurn()
        {
            var html = ReadRepoFile("RevitBridge", "Operator", "OperatorWebUiHtml.cs");
            var pane = ReadRepoFile("RevitBridge", "Operator", "OperatorPaneControl.cs");

            Assert.Contains("id=\"\"agentModel\"\"", html);
            Assert.Contains("gpt-5.6-luna", html);
            Assert.Contains("<option value=\"\"max\"\">Max</option>", html);
            Assert.Contains("agent_model: agentModel", html);
            Assert.Contains("agent_reasoning_effort: agentEffort", html);
            Assert.Contains("split_planner_executor: false", html);
            Assert.DoesNotContain("speedPlanner", html);
            Assert.DoesNotContain("speedExecutor", html);

            Assert.Contains("\\\"agent_model\\\":\\\"gpt-5.6-sol\\\"", pane);
            Assert.Contains("\\\"agent_reasoning_effort\\\":\\\"medium\\\"", pane);
            Assert.Contains("\\\"split_planner_executor\\\":false", pane);
            Assert.DoesNotContain("\\\"executor_model\\\":\\\"gpt-5.6-terra\\\"", pane);
        }

        private static string ReadRepoFile(params string[] relativeSegments)
        {
            var cursor = new DirectoryInfo(AppContext.BaseDirectory);
            while (cursor != null)
            {
                foreach (var prefix in new[]
                {
                    new[] { "revit-bridge-addin" },
                    new[] { "apps", "revit-bridge-addin" }
                })
                {
                    var candidate = Path.Combine(
                        new[] { cursor.FullName }.Concat(prefix).Concat(relativeSegments).ToArray());
                    if (File.Exists(candidate)) return File.ReadAllText(candidate);
                }
                cursor = cursor.Parent;
            }

            throw new FileNotFoundException("Could not locate Operator source file.", Path.Combine(relativeSegments));
        }
    }
}
