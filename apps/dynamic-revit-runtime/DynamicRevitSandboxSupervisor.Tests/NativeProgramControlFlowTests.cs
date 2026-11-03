using System.Reflection;
using System.Runtime.Loader;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using RevitOperator.DynamicRevitSdk;
using RevitOperator.DynamicRevitWorker;
using Xunit;

namespace RevitOperator.DynamicRevitSandboxSupervisor.Tests;

public sealed class NativeProgramControlFlowTests
{
    // Native-free executable harness. The stub supplies only Document's type
    // identity; no Revit installation/model/native API is invoked by these tests.
    private static (NativeCompilerReference[] References, byte[] Stub) References()
    {
        var core = new[] { "mscorlib", "System", "System.Core" }.Select(n =>
        {
            var bytes = File.ReadAllBytes(Path.Combine(NativeProgramCompilerTests.Framework, n + ".dll"));
            return new NativeCompilerReference(n, bytes, DynamicWire.Sha256(bytes));
        }).ToArray();
        var compilation = CSharpCompilation.Create("RevitAPI", new[] { CSharpSyntaxTree.ParseText(
            "[assembly:System.Reflection.AssemblyVersion(\"24.0.0.0\")] namespace Autodesk.Revit.DB {public class Document {}}") },
            core.Select(r => MetadataReference.CreateFromImage(r.Image)), new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary));
        using var image = new MemoryStream(); var emit = compilation.Emit(image);
        Assert.True(emit.Success, string.Join(";", emit.Diagnostics));
        var stub = image.ToArray();
        return (core.Append(new NativeCompilerReference("RevitAPI", stub, DynamicWire.Sha256(stub))).ToArray(), stub);
    }
    private static string Source(string body, string helpers = "") =>
        "using System; using System.Linq; using Autodesk.Revit.DB; public static class NativeTask { " +
        "public static string Execute(Document doc) { " + body + " } " + helpers + " }";
    private static string WithProgram(string source, Func<Assembly, string> execute)
    {
        var refs = References();
        var compiled = NativeProgramCompiler.Compile(source, "NativeTask", "read", 2024, refs.References);
        Assert.Empty(compiled.Diagnostics); Assert.NotNull(compiled.Artifact);
        var context = new AssemblyLoadContext("native-free-control-flow-test", isCollectible: true);
        context.Resolving += (_, name) => name.Name == "RevitAPI" ? context.LoadFromStream(new MemoryStream(refs.Stub)) : null;
        try
        {
            var assembly = context.LoadFromStream(new MemoryStream(compiled.Artifact!.Assembly));
            return execute(assembly);
        }
        finally { context.Unload(); }
    }
    private static string Invoke(Assembly assembly, Action? checkpoint, bool direct = false)
    {
        var entry = assembly.GetType(direct ? "NativeTask" : "RevitOperator.Generated.NativeExecutionBoundaryV1");
        Assert.NotNull(entry);
        try { return (string)entry!.GetMethod(direct ? "Execute" : "Run")!.Invoke(null,
            direct ? new object?[] { null } : new object?[] { null, checkpoint })!; }
        catch (TargetInvocationException e) { System.Runtime.ExceptionServices.ExceptionDispatchInfo.Capture(e.InnerException!).Throw(); throw; }
    }
    private static string Run(string source, Action checkpoint) => WithProgram(source, assembly => Invoke(assembly, checkpoint));

    [NativeCompileFact]
    public void OrdinaryReadAlgorithmReturnsWithoutNativeExecutionOrAWriteGrant()
    {
        var ticks = 0;
        var answer = Run(Source("return Enumerable.Range(1,20).Where(n=>n%2==0).Sum().ToString();"), () => ticks++);
        Assert.Equal("110", answer); Assert.True(ticks >= 20);
        Assert.Equal("NativeExecutionBoundaryV1", Run(Source("return \"NativeExecutionBoundaryV1\";"), () => { }));
    }

    [NativeCompileFact]
    public void InfiniteManagedLoopStopsAtHostCheckpoint()
    {
        var ticks = 0;
        var error = Assert.Throws<InvalidOperationException>(() => Run(Source("while(true){}"),
            () => { if (++ticks >= 20) throw new InvalidOperationException("host-budget-exhausted"); }));
        Assert.Equal("host-budget-exhausted", error.Message); Assert.InRange(ticks, 20, 21);
    }

    [Theory]
    [InlineData("for(;;);", "")]
    [InlineData("do ; while(true);", "")]
    [InlineData("return F(0).ToString();", "static int F(int n)=>F(n+1);")]
    [InlineData("int F(int n)=>F(n+1);return F(0).ToString();", "")]
    [InlineData("return P.ToString();", "static int P=>P;")]
    [InlineData("Func<int,int> f=null; f=n=>f(n+1);return f(0).ToString();", "")]
    [InlineData("Action f=null; f=()=>f(); f();return \"never\";", "")]
    [InlineData("foreach(var n in Items()){}return \"never\";", "static System.Collections.Generic.IEnumerable<int> Items(){while(true)yield return 1;}")]
    public void OtherLoopAndExpressionBodyFormsRetainCheckpoints(string body, string helpers)
    {
        var ticks = 0;
        var error = Assert.Throws<InvalidOperationException>(() => Run(Source(body, helpers),
            () => { if (++ticks >= 20) throw new InvalidOperationException("host-budget-exhausted"); }));
        Assert.Equal("host-budget-exhausted", error.Message); Assert.InRange(ticks, 20, 22);
    }

    [NativeCompileFact]
    public void CaughtStopCannotBecomeSuccessfulResultAndBoundaryClearsAfterException()
    {
        WithProgram(Source("try{while(true){}}catch(Exception){return \"pretend-complete\";}"), assembly =>
        {
            var ticks = 0;
            Assert.Throws<InvalidOperationException>(() => Invoke(assembly,
                () => { if (++ticks >= 20) throw new InvalidOperationException("host-budget-exhausted"); }));
            // If callback state leaked, a second entry would report nested entry
            // rather than the NEW host's specific failure.
            var error = Assert.Throws<ArgumentException>(() => Invoke(assembly, () => throw new ArgumentException("new-host-stop")));
            Assert.Equal("new-host-stop", error.Message);
            return "checked";
        });
    }

    [NativeCompileFact]
    public void DirectEntryMissingCallbackOversizeAndNullResultsCannotBypassBoundary()
    {
        WithProgram(Source("return \"answer\";"), assembly =>
        {
            Assert.Throws<InvalidOperationException>(() => Invoke(assembly, null, direct: true));
            Assert.Throws<ArgumentNullException>(() => Invoke(assembly, null));
            Assert.Equal("answer", Invoke(assembly, () => { }));
            Assert.Throws<InvalidOperationException>(() => Invoke(assembly, null, direct: true));
            return "checked";
        });
        Assert.Throws<InvalidOperationException>(() => Run(Source("return new string('x',32769);"), () => { }));
        Assert.Throws<InvalidOperationException>(() => Run(Source("return null;"), () => { }));
    }

    [NativeCompileFact]
    public void TaskSourceCannotNameBoundaryCreateFinalizersOrScheduleAsyncWork()
    {
        var refs = References();
        foreach(var source in new[] {
            Source("RevitOperator.Generated.NativeExecutionBoundaryV1.Checkpoint();return \"\";"),
            Source("return \"\";", "class Later{~Later(){}}"),
            Source("Later();return \"\";", "static async void Later(){}") })
        {
            var result = NativeProgramCompiler.Compile(source, "NativeTask", "read", 2024, refs.References);
            Assert.Null(result.Artifact);
            Assert.Contains(result.Diagnostics, d => d.Code is "NATIVE_RESERVED_BOUNDARY" or "NATIVE_SOURCE_LIFECYCLE");
        }
    }
}
