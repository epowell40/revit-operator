using System.Security.Cryptography;
using RevitOperator.DynamicRevitSdk;
using Xunit;

namespace DynamicRevitSdk.Tests;

public sealed class AdmissionTests
{
    [Fact] public void RejectsTooManyOperations()
    {
        var graph = Graph(Move("a"), Move("b"));
        Assert.Throws<ArgumentException>(() => DynamicOperationGraphAdmission.Validate(graph, 1, 1));
    }
    [Fact] public void RejectsDuplicateOperations()
    {
        var operation = Move("a");
        Assert.Throws<ArgumentException>(() => DynamicOperationGraphAdmission.Validate(Graph(operation, operation), 2, 2));
    }
    [Fact] public void RejectsMultipleOperationsOnOneTarget()
    {
        Assert.Throws<ArgumentException>(() => DynamicOperationGraphAdmission.Validate(Graph(Move("a"), Set("a")), 2, 2));
    }
    [Fact] public void RejectsUnexpectedTarget()
    {
        Assert.Throws<ArgumentException>(() => DynamicOperationGraphAdmission.Validate(Graph(Move("outside")), 2, 2, new[] { "inside" }));
    }
    [Fact] public void RejectsOverBudgetParameterMutation()
    {
        Assert.Throws<ArgumentException>(() => DynamicOperationGraphAdmission.Validate(Graph(Set("a"), Set("b")), 2, 1));
    }
    [Fact] public void RejectsUnsupportedOperationKind()
    {
        var operation = new DynamicOperation { Kind = "delete_element", TargetUniqueId = "a", OperationId = "" };
        Assert.Throws<ArgumentException>(() => DynamicOperationGraphAdmission.Validate(Graph(operation), 1, 1));
    }
    [Fact] public void RejectsOversizedMove()
    {
        var operation = Move("a"); operation.VectorFeet = new[] { 151d, 0d, 0d }; operation.OperationId = DynamicWire.OperationId(operation);
        Assert.Throws<ArgumentException>(() => DynamicOperationGraphAdmission.Validate(Graph(operation), 1, 1));
    }
    [Fact] public void RejectsWrongDocumentBindingAndWrongSignature()
    {
        var key = RandomNumberGenerator.GetBytes(32);
        var admission = Admission(); admission.Signature = DynamicWire.SignAdmission(admission, key);
        Assert.Throws<InvalidOperationException>(() => DynamicWorkerAdmissionPolicy.Validate(admission, key, admission.LauncherExecutableHash, admission.SandboxProfile, admission.SourceHash, admission.ProgramHash, admission.SdkHash, admission.OperationGraphHash, "wrong-document", admission.DocumentSessionId, DateTimeOffset.UtcNow.ToUnixTimeSeconds()));
        Assert.Throws<InvalidOperationException>(() => DynamicWorkerAdmissionPolicy.Validate(admission, RandomNumberGenerator.GetBytes(32), admission.LauncherExecutableHash, admission.SandboxProfile, admission.SourceHash, admission.ProgramHash, admission.SdkHash, admission.OperationGraphHash, admission.DocumentFingerprint, admission.DocumentSessionId, DateTimeOffset.UtcNow.ToUnixTimeSeconds()));
    }
    [Fact] public void AcceptsBoundAdmissionAndBoundGraph()
    {
        var graph = Graph(Move("inside"));
        DynamicOperationGraphAdmission.Validate(graph, 2, 2, new[] { "inside" });
        var key = RandomNumberGenerator.GetBytes(32); var admission = Admission(); admission.Signature = DynamicWire.SignAdmission(admission, key);
        DynamicWorkerAdmissionPolicy.Validate(admission, key, admission.LauncherExecutableHash, admission.SandboxProfile, admission.SourceHash, admission.ProgramHash, admission.SdkHash, admission.OperationGraphHash, admission.DocumentFingerprint, admission.DocumentSessionId, DateTimeOffset.UtcNow.ToUnixTimeSeconds());
    }
    [Fact] public void InputHashIsStableAcrossDictionaryInsertionOrderAndSensitiveToExactDoubleBits()
    {
        var first = Input(new Dictionary<string, string?> { ["B"] = "2", ["A"] = "1" }, 1d);
        var reordered = Input(new Dictionary<string, string?> { ["A"] = "1", ["B"] = "2" }, 1d);
        var changed = Input(new Dictionary<string, string?> { ["A"] = "1", ["B"] = "2" }, BitConverter.Int64BitsToDouble(BitConverter.DoubleToInt64Bits(1d) + 1));
        Assert.Equal(DynamicWire.InputHash(first), DynamicWire.InputHash(reordered));
        Assert.NotEqual(DynamicWire.InputHash(first), DynamicWire.InputHash(changed));
    }

    private static DynamicOperation Move(string target)
    {
        var operation = new DynamicOperation { Kind = "move_element", TargetUniqueId = target, VectorFeet = new[] { 1d, 0d, 0d } }; operation.OperationId = DynamicWire.OperationId(operation); return operation;
    }
    private static DynamicOperation Set(string target)
    {
        var operation = new DynamicOperation { Kind = "set_parameter", TargetUniqueId = target, Parameter = "Comments", Value = "QA" }; operation.OperationId = DynamicWire.OperationId(operation); return operation;
    }
    private static DynamicOperationGraph Graph(params DynamicOperation[] operations)
    {
        var graph = new DynamicOperationGraph { InputHash = DynamicWire.Sha256("input"), Operations = operations }; graph.GraphHash = DynamicWire.GraphHash(graph); return graph;
    }
    private static DynamicTaskInput Input(Dictionary<string, string?> parameters, double x) => new()
    {
        OperationBudget = 8,
        Document = new DynamicDocumentDto { ProjectFingerprint = "doc", SessionId = "session", Title = "title", ActiveViewId = 7, ActiveViewName = "view" },
        Elements = new[] { new DynamicElementDto { UniqueId = "id", ElementId = 42, Category = "category", Parameters = parameters, WritableParameters = new[] { "A" }, Location = new DynamicPointDto { X = x, Y = 2d, Z = 3d } } }
    };
    private static DynamicWorkerAdmission Admission() => new()
    {
        RuntimeInstanceId = "runtime", LauncherExecutableHash = DynamicWire.Sha256("launcher"), WorkerExecutableHash = DynamicWire.Sha256("worker"), SandboxProfile = "windows-appcontainer-v1-zero-capabilities", WorkerProcessId = 42, StartupNonceHash = DynamicWire.Sha256("nonce"), TaskDirectoryIdentity = DynamicWire.Sha256("task"), SourceHash = DynamicWire.Sha256("source"), ProgramHash = DynamicWire.Sha256("program"), SdkHash = DynamicWire.Sha256("sdk"), OperationGraphHash = DynamicWire.Sha256("graph"), DocumentFingerprint = DynamicWire.Sha256("document"), DocumentSessionId = "session", CorrelationId = Guid.NewGuid().ToString("N"), ExpiresUnixSeconds = DateTimeOffset.UtcNow.AddMinutes(2).ToUnixTimeSeconds()
    };
}
