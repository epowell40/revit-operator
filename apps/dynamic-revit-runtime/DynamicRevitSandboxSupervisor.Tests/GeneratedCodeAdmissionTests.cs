using RevitOperator.DynamicRevitSdk;
using RevitOperator.DynamicRevitWorker;
using Xunit;

namespace RevitOperator.DynamicRevitSandboxSupervisor.Tests;

public sealed class GeneratedCodeAdmissionTests
{
    private static WorkerOutput Run(string body) => WorkerExecutor.Execute(new WorkerInput
    {
        Source = "using System; using System.Linq; using RevitOperator.DynamicRevitSdk; " +
            "public sealed class Generated : IDynamicRevitProgram { public DynamicProgramResult Execute(DynamicRevitContext c) { " +
            body + " return c.Complete(); } }",
        Input = new DynamicTaskInput { OperationBudget = 1 }
    });

    [Theory]
    [InlineData("// dynamic System.IO Autodesk.Revit unsafe\n c.Report(\"answer\", \"42\");")]
    [InlineData("/* System.Reflection typeof(object) */ c.Report(\"answer\", \"42\");")]
    [InlineData("c.Log(\"dynamic report mentions System.IO and Autodesk.Revit\"); c.Report(\"answer\", \"42\");")]
    [InlineData("c.Log(@\"System.IO dynamic\"); c.Report(\"answer\", \"42\");")]
    [InlineData("c.Log(\"\"\"System.IO dynamic\"\"\"); c.Report(\"answer\", \"42\");")]
    [InlineData("c.Log($\"System.IO dynamic {6 * 7}\"); c.Report(\"answer\", \"42\");")]
    [InlineData("var aerodynamic = Enumerable.Range(1, 6).Sum() * 2; c.Report(\"answer\", aerodynamic.ToString());")]
    public void ProseAndOrdinaryAlgorithmsDoNotGrantOrTriggerForbiddenApiUse(string body)
    {
        var result = Run(body);
        Assert.True(result.Ok, string.Join("; ", result.Diagnostics.Select(d => d.Code + ": " + d.Message)));
        Assert.True(result.DeterministicReplayVerified);
        Assert.Equal("42", result.Report["answer"]);
        Assert.Empty(result.Graph!.Operations);
    }

    [Theory]
    [InlineData("c.Log($\"value {System.IO.File.ReadAllText(\"missing\")}\");")]
    [InlineData("c.Log(System./* not prose */IO.File.ReadAllText(\"missing\"));")]
    [InlineData("c.Log(System.\\u0049O.File.ReadAllText(\"missing\"));")]
    [InlineData("var t = typeof /* gap */ (object);")]
    [InlineData("var t = c.GetType /* gap */ ();")]
    [InlineData("dynamic value = 42;")]
    [InlineData("System.Environment.Exit(0);")]
    public void ExecutableForbiddenTokensRemainRejectedWithSourceRanges(string body)
    {
        var result = Run(body);
        Assert.False(result.Ok);
        Assert.Contains(result.Diagnostics, diagnostic => diagnostic.Code == "POLICY_SOURCE_FORBIDDEN" &&
            diagnostic.Line > 0 && diagnostic.Column > 0 && diagnostic.EndColumn > diagnostic.Column);
        Assert.Null(result.Graph);
    }

    [Fact]
    public void AliasedForbiddenApiIsRejectedBySemanticAdmission()
    {
        var result = WorkerExecutor.Execute(new WorkerInput
        {
            Source = "using E = System.Environment; using RevitOperator.DynamicRevitSdk; public class X : IDynamicRevitProgram { " +
                "public DynamicProgramResult Execute(DynamicRevitContext c) { c.Log(E.UserName); return c.Complete(); } }",
            Input = new DynamicTaskInput { OperationBudget = 1 }
        });
        Assert.False(result.Ok);
        Assert.Contains(result.Diagnostics, diagnostic => diagnostic.Code == "POLICY_SYMBOL_FORBIDDEN");
        Assert.Null(result.Graph);
    }

    [Fact]
    public void RuntimeFailureRetainsExceptionTypeForRepairWithoutAFalseSuccess()
    {
        var result = Run("throw new InvalidOperationException(\"No eligible connector\");");
        Assert.False(result.Ok);
        Assert.Null(result.Graph);
        var diagnostic = Assert.Single(result.Diagnostics);
        Assert.Equal("PROGRAM_EXCEPTION", diagnostic.Code);
        Assert.Equal("System.InvalidOperationException: No eligible connector", diagnostic.Message);
        Assert.Equal("inspect_trace_and_repair_source", diagnostic.RepairAction);
    }
}
