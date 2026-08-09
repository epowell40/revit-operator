using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Security.Cryptography;
using System.Text;

namespace RevitOperator.DynamicRevitSdk;

public static class DynamicRevitSdkVersion
{
    public const string Value = "dynamic-revit-sdk/v0";
    public const string GraphSchema = "dynamic-revit-operation-graph/v0";
    public static string ManifestHash => DynamicWire.Sha256(Value + "\n" + GraphSchema + "\nDynamicTaskInput\nDynamicElementDto\nMoveElement\nSetParameter\nBoundedStructuredReport\nDynamicWorkerAdmission\nCanonicalInputHashV1\nNoSystemTextJsonDependencyV1\nAuthenticatedLauncherSessionV1\n" + DynamicObservationContractV1.ManifestHash + "\n" + DynamicBuildingSystemsObservationContractV1.ManifestHash + "\n" + DynamicCoreOperationManifestV1.ManifestHash + "\n" + DynamicResultReferenceManifestV1.ManifestHash + "\n" + DynamicAnnotationOperationManifestV1.ManifestHash);
}

public sealed class DynamicDocumentDto
{
    public string ProjectFingerprint { get; set; } = "";
    public string SessionId { get; set; } = "";
    public string Title { get; set; } = "";
    public long ActiveViewId { get; set; }
    public string ActiveViewName { get; set; } = "";
}

public sealed class DynamicPointDto { public double X { get; set; } public double Y { get; set; } public double Z { get; set; } }
public sealed class DynamicBoxDto { public DynamicPointDto? Min { get; set; } public DynamicPointDto? Max { get; set; } }

public sealed class DynamicElementDto
{
    public string UniqueId { get; set; } = "";
    public long ElementId { get; set; }
    public string Category { get; set; } = "";
    public string? FamilyName { get; set; }
    public string? TypeName { get; set; }
    public Dictionary<string, string?> Parameters { get; set; } = new(StringComparer.Ordinal);
    public string[] WritableParameters { get; set; } = Array.Empty<string>();
    public DynamicPointDto? Location { get; set; }
    public string? LocationKind { get; set; }
    public DynamicBoxDto? BoundingBox { get; set; }
    public bool IsPinned { get; set; }
    public bool IsGrouped { get; set; }
    public string? HostUniqueId { get; set; }
}

public sealed class DynamicTaskInput
{
    public DynamicDocumentDto Document { get; set; } = new();
    public IReadOnlyList<DynamicElementDto> Elements { get; set; } = Array.Empty<DynamicElementDto>();
    public int OperationBudget { get; set; } = 32;
}

public sealed class DynamicProgramResult
{
    public DynamicOperationGraph Graph { get; set; } = new();
    public IReadOnlyList<string> Logs { get; set; } = Array.Empty<string>();
    public IReadOnlyDictionary<string, string> Report { get; set; } = new Dictionary<string, string>(StringComparer.Ordinal);
}

public sealed class DynamicWorkerAdmission
{
    public string Schema { get; set; } = "dynamic-revit-worker-admission/v0";
    public string RuntimeInstanceId { get; set; } = "";
    public string LauncherExecutableHash { get; set; } = "";
    public string WorkerExecutableHash { get; set; } = "";
    public string SandboxProfile { get; set; } = "";
    public int WorkerProcessId { get; set; }
    public string StartupNonceHash { get; set; } = "";
    public string TaskDirectoryIdentity { get; set; } = "";
    public string SourceHash { get; set; } = "";
    public string ProgramHash { get; set; } = "";
    public string SdkVersion { get; set; } = DynamicRevitSdkVersion.Value;
    public string SdkHash { get; set; } = "";
    public string OperationGraphHash { get; set; } = "";
    public string DocumentFingerprint { get; set; } = "";
    public string DocumentSessionId { get; set; } = "";
    public string CorrelationId { get; set; } = "";
    public long ExpiresUnixSeconds { get; set; }
    public string Signature { get; set; } = "";
}

public interface IDynamicRevitProgram { DynamicProgramResult Execute(DynamicRevitContext context); }

public sealed class DynamicRevitContext
{
    private readonly List<string> _logs = new();
    private readonly Dictionary<string, string> _report = new(StringComparer.Ordinal);
    public DynamicRevitContext(DynamicTaskInput input)
    {
        Input = input ?? throw new ArgumentNullException(nameof(input));
        Plan = new DynamicOperationGraphBuilder(input.OperationBudget);
    }
    public DynamicTaskInput Input { get; }
    public DynamicOperationGraphBuilder Plan { get; }
    public IReadOnlyList<DynamicElementDto> Elements => Input.Elements;
    public void Log(string message)
    {
        if (string.IsNullOrWhiteSpace(message) || _logs.Count >= 64) return;
        _logs.Add(message.Trim().Length > 512 ? message.Trim().Substring(0, 512) : message.Trim());
    }
    public void Report(string key, string value)
    {
        if (string.IsNullOrWhiteSpace(key) || key.Length > 128 || value == null || value.Length > 1024 || _report.Count >= 64 && !_report.ContainsKey(key)) throw new ArgumentException("Structured report entry is outside the bounded SDK contract.");
        _report[key.Trim()] = value;
    }
    public DynamicProgramResult Complete() => new() { Graph = Plan.Build(), Logs = _logs.ToArray(), Report = new Dictionary<string, string>(_report, StringComparer.Ordinal) };
}

public sealed class DynamicOperationGraph
{
    public string Schema { get; set; } = DynamicRevitSdkVersion.GraphSchema;
    public string InputHash { get; set; } = "";
    public IReadOnlyList<DynamicOperation> Operations { get; set; } = Array.Empty<DynamicOperation>();
    public string GraphHash { get; set; } = "";
}

public sealed class DynamicOperation
{
    public string OperationId { get; set; } = "";
    public string Kind { get; set; } = "";
    public string TargetUniqueId { get; set; } = "";
    public double[]? VectorFeet { get; set; }
    public string? Parameter { get; set; }
    public string? Value { get; set; }
}

public sealed class DynamicOperationGraphBuilder
{
    private readonly int _budget;
    private readonly List<DynamicOperation> _operations = new();
    public DynamicOperationGraphBuilder(int operationBudget)
    {
        if (operationBudget < 1 || operationBudget > 256) throw new ArgumentOutOfRangeException(nameof(operationBudget));
        _budget = operationBudget;
    }
    public void MoveElement(DynamicElementDto element, double xFeet, double yFeet, double zFeet)
        => MoveElement(element?.UniqueId ?? "", xFeet, yFeet, zFeet);
    public void MoveElement(string targetUniqueId, double xFeet, double yFeet, double zFeet)
    {
        if (double.IsNaN(xFeet) || double.IsInfinity(xFeet) || double.IsNaN(yFeet) || double.IsInfinity(yFeet) || double.IsNaN(zFeet) || double.IsInfinity(zFeet)) throw new ArgumentException("Move vector must be finite.");
        Add(new DynamicOperation { Kind = "move_element", TargetUniqueId = Required(targetUniqueId), VectorFeet = new[] { xFeet, yFeet, zFeet } });
    }
    public void SetParameter(DynamicElementDto element, string parameter, string value)
        => SetParameter(element?.UniqueId ?? "", parameter, value);
    public void SetParameter(string targetUniqueId, string parameter, string value)
        => Add(new DynamicOperation { Kind = "set_parameter", TargetUniqueId = Required(targetUniqueId), Parameter = Required(parameter), Value = Required(value) });
    public DynamicOperationGraph Build()
    {
        var operations = _operations.Select(CloneAndIdentify).ToArray();
        var graph = new DynamicOperationGraph { Operations = operations, InputHash = "worker-computed" };
        graph.GraphHash = DynamicWire.GraphHash(graph);
        return graph;
    }
    private void Add(DynamicOperation operation)
    {
        if (_operations.Count >= _budget) throw new InvalidOperationException("Operation budget exceeded.");
        _operations.Add(operation);
    }
    private static DynamicOperation CloneAndIdentify(DynamicOperation operation)
    {
        var clone = new DynamicOperation { Kind = operation.Kind, TargetUniqueId = operation.TargetUniqueId, VectorFeet = operation.VectorFeet, Parameter = operation.Parameter, Value = operation.Value };
        clone.OperationId = DynamicWire.OperationId(clone);
        return clone;
    }
    private static string Required(string value) => string.IsNullOrWhiteSpace(value) ? throw new ArgumentException("Value is required.") : value.Trim();
}

public static class DynamicWire
{
    public static string Sha256(string value)
    {
        return Sha256(Encoding.UTF8.GetBytes(value ?? ""));
    }
    public static string Sha256(byte[] bytes)
    {
        using var sha = SHA256.Create();
        return "sha256:" + BitConverter.ToString(sha.ComputeHash(bytes ?? Array.Empty<byte>())).Replace("-", "").ToLowerInvariant();
    }
    public static string OperationId(DynamicOperation operation)
    {
        if (operation.Kind == "move_element") return Sha256("move_element\n" + operation.TargetUniqueId + "\n" + string.Join(",", operation.VectorFeet!.Select(v => v.ToString("R", CultureInfo.InvariantCulture))));
        if (operation.Kind == "set_parameter") return Sha256("set_parameter\n" + operation.TargetUniqueId + "\n" + operation.Parameter + "\n" + operation.Value);
        return "";
    }
    public static string InputHash(DynamicTaskInput input)
    {
        if (input == null) throw new ArgumentNullException(nameof(input));
        var builder = new StringBuilder("dynamic-revit-input-canonical/v1\n");
        Append(builder, input.OperationBudget.ToString(CultureInfo.InvariantCulture));
        var document = input.Document ?? new DynamicDocumentDto();
        Append(builder, document.ProjectFingerprint);
        Append(builder, document.SessionId);
        Append(builder, document.Title);
        Append(builder, document.ActiveViewId.ToString(CultureInfo.InvariantCulture));
        Append(builder, document.ActiveViewName);
        var elements = input.Elements ?? Array.Empty<DynamicElementDto>();
        Append(builder, elements.Count.ToString(CultureInfo.InvariantCulture));
        foreach (var element in elements)
        {
            Append(builder, element.UniqueId);
            Append(builder, element.ElementId.ToString(CultureInfo.InvariantCulture));
            Append(builder, element.Category);
            Append(builder, element.FamilyName);
            Append(builder, element.TypeName);
            var parameters = element.Parameters ?? new Dictionary<string, string?>();
            Append(builder, parameters.Count.ToString(CultureInfo.InvariantCulture));
            foreach (var pair in parameters.OrderBy(pair => pair.Key, StringComparer.Ordinal))
            {
                Append(builder, pair.Key);
                Append(builder, pair.Value);
            }
            var writable = element.WritableParameters ?? Array.Empty<string>();
            Append(builder, writable.Length.ToString(CultureInfo.InvariantCulture));
            foreach (var name in writable) Append(builder, name);
            AppendPoint(builder, element.Location);
            Append(builder, element.LocationKind);
            AppendBox(builder, element.BoundingBox);
            Append(builder, element.IsPinned ? "1" : "0");
            Append(builder, element.IsGrouped ? "1" : "0");
            Append(builder, element.HostUniqueId);
        }
        return Sha256(builder.ToString());
    }
    private static void Append(StringBuilder builder, string? value)
    {
        if (value == null) builder.Append("-\n");
        else builder.Append('+').Append(Convert.ToBase64String(Encoding.UTF8.GetBytes(value))).Append('\n');
    }
    private static void AppendPoint(StringBuilder builder, DynamicPointDto? point)
    {
        if (point == null) { Append(builder, null); return; }
        Append(builder, "point");
        AppendDouble(builder, point.X);
        AppendDouble(builder, point.Y);
        AppendDouble(builder, point.Z);
    }
    private static void AppendBox(StringBuilder builder, DynamicBoxDto? box)
    {
        if (box == null) { Append(builder, null); return; }
        Append(builder, "box");
        AppendPoint(builder, box.Min);
        AppendPoint(builder, box.Max);
    }
    private static void AppendDouble(StringBuilder builder, double value)
        => Append(builder, BitConverter.DoubleToInt64Bits(value).ToString("x16", CultureInfo.InvariantCulture));
    public static string GraphHash(DynamicOperationGraph graph)
    {
        var canonical = string.Join("\n", graph.Operations.Select(op => op.OperationId));
        return Sha256(DynamicRevitSdkVersion.GraphSchema + "\n" + graph.InputHash + "\n" + canonical);
    }
    public static string AdmissionCanonical(DynamicWorkerAdmission admission)
        => string.Join("\n", new[]
        {
            admission.Schema, admission.RuntimeInstanceId, admission.LauncherExecutableHash, admission.WorkerExecutableHash,
            admission.SandboxProfile, admission.WorkerProcessId.ToString(CultureInfo.InvariantCulture), admission.StartupNonceHash,
            admission.TaskDirectoryIdentity, admission.SourceHash, admission.ProgramHash, admission.SdkVersion, admission.SdkHash,
            admission.OperationGraphHash, admission.DocumentFingerprint, admission.DocumentSessionId, admission.CorrelationId,
            admission.ExpiresUnixSeconds.ToString(CultureInfo.InvariantCulture)
        });
    public static string SignAdmission(DynamicWorkerAdmission admission, byte[] key)
    {
        using var hmac = new HMACSHA256(key ?? Array.Empty<byte>());
        return "hmac-sha256:" + BitConverter.ToString(hmac.ComputeHash(Encoding.UTF8.GetBytes(AdmissionCanonical(admission)))).Replace("-", "").ToLowerInvariant();
    }
    public static bool VerifyAdmission(DynamicWorkerAdmission admission, byte[] key)
    {
        var expected = SignAdmission(admission, key);
        var left = Encoding.ASCII.GetBytes(expected);
        var right = Encoding.ASCII.GetBytes(admission.Signature ?? "");
        if (left.Length != right.Length) return false;
        var difference = 0;
        for (var i = 0; i < left.Length; i++) difference |= left[i] ^ right[i];
        return difference == 0;
    }
    public static string SignSessionMessage(byte[] key, string purpose, string runtimeInstanceId, string correlationId, long expiresUnixSeconds, string payloadHash)
    {
        var canonical = string.Join("\n", new[] { purpose ?? "", runtimeInstanceId ?? "", correlationId ?? "", expiresUnixSeconds.ToString(CultureInfo.InvariantCulture), payloadHash ?? "" });
        using var hmac = new HMACSHA256(key ?? Array.Empty<byte>());
        return "hmac-sha256:" + BitConverter.ToString(hmac.ComputeHash(Encoding.UTF8.GetBytes(canonical))).Replace("-", "").ToLowerInvariant();
    }
    public static bool VerifySessionMessage(byte[] key, string purpose, string runtimeInstanceId, string correlationId, long expiresUnixSeconds, string payloadHash, string signature)
    {
        var expected = Encoding.ASCII.GetBytes(SignSessionMessage(key, purpose, runtimeInstanceId, correlationId, expiresUnixSeconds, payloadHash));
        var observed = Encoding.ASCII.GetBytes(signature ?? "");
        if (expected.Length != observed.Length) return false;
        var difference = 0;
        for (var i = 0; i < expected.Length; i++) difference |= expected[i] ^ observed[i];
        return difference == 0;
    }
}

public static class DynamicOperationGraphAdmission
{
    public static void Validate(DynamicOperationGraph graph, int operationBudget, int parameterMutationBudget, IEnumerable<string>? allowedTargetIds = null)
    {
        if (graph == null || operationBudget < 1 || operationBudget > 256 || parameterMutationBudget < 0 || parameterMutationBudget > operationBudget || graph.Schema != DynamicRevitSdkVersion.GraphSchema || graph.Operations == null || graph.Operations.Count < 1 || graph.Operations.Count > operationBudget || !Hash(graph.InputHash)) throw new ArgumentException("Dynamic operation graph is invalid.");
        var allowed = allowedTargetIds == null ? null : new HashSet<string>(allowedTargetIds, StringComparer.Ordinal);
        var operationIds = new HashSet<string>(StringComparer.Ordinal);
        var targetIds = new HashSet<string>(StringComparer.Ordinal);
        var parameterMutations = 0;
        foreach (var operation in graph.Operations!)
        {
            if (string.IsNullOrWhiteSpace(operation.TargetUniqueId) || operation.TargetUniqueId.Length > 256 || (allowed != null && !allowed.Contains(operation.TargetUniqueId)) || operation.OperationId != DynamicWire.OperationId(operation) || !operationIds.Add(operation.OperationId) || !targetIds.Add(operation.TargetUniqueId)) throw new ArgumentException("Dynamic operation identity or target scope is invalid; Phase-2 preview permits at most one operation per target.");
            if (operation.Kind == "move_element" && (operation.VectorFeet == null || operation.VectorFeet.Length != 3 || operation.VectorFeet.Any(v => double.IsNaN(v) || double.IsInfinity(v) || Math.Abs(v) > 100d) || Math.Sqrt(operation.VectorFeet.Sum(v => v * v)) > 150d)) throw new ArgumentException("Move operation is invalid.");
            if (operation.Kind == "set_parameter")
            {
                parameterMutations++;
                if (string.IsNullOrWhiteSpace(operation.Parameter) || operation.Parameter!.Length > 128 || operation.Value == null || operation.Value!.Length > 512) throw new ArgumentException("Set parameter operation is invalid.");
            }
            if (operation.Kind != "move_element" && operation.Kind != "set_parameter") throw new ArgumentException("Unsupported dynamic operation kind.");
        }
        if (parameterMutations > parameterMutationBudget) throw new ArgumentException("Dynamic parameter mutation budget exceeded.");
        if (graph.GraphHash != DynamicWire.GraphHash(graph)) throw new ArgumentException("Dynamic operation graph hash is invalid.");
    }
    private static bool Hash(string? value) => value != null && System.Text.RegularExpressions.Regex.IsMatch(value, "^sha256:[0-9a-f]{64}$");
}

public static class DynamicWorkerAdmissionPolicy
{
    public static void Validate(DynamicWorkerAdmission admission, byte[] signingKey, string launcherHash, string sandboxProfile, string sourceHash, string programHash, string sdkHash, string graphHash, string documentFingerprint, string documentSessionId, long nowUnixSeconds)
    {
        if (admission == null || admission.Schema != "dynamic-revit-worker-admission/v0" || admission.WorkerProcessId <= 0 || admission.ExpiresUnixSeconds <= nowUnixSeconds || admission.ExpiresUnixSeconds > nowUnixSeconds + 300) throw new InvalidOperationException("Dynamic worker admission is invalid or expired.");
        if (!string.Equals(admission.LauncherExecutableHash, launcherHash, StringComparison.Ordinal) || !string.Equals(admission.SandboxProfile, sandboxProfile, StringComparison.Ordinal) || !string.Equals(admission.SourceHash, sourceHash, StringComparison.Ordinal) || !string.Equals(admission.ProgramHash, programHash, StringComparison.Ordinal) || !string.Equals(admission.SdkHash, sdkHash, StringComparison.Ordinal) || !string.Equals(admission.OperationGraphHash, graphHash, StringComparison.Ordinal) || !string.Equals(admission.DocumentFingerprint, documentFingerprint, StringComparison.Ordinal) || !string.Equals(admission.DocumentSessionId, documentSessionId, StringComparison.Ordinal)) throw new InvalidOperationException("Dynamic worker admission bindings do not match.");
        if (!DynamicWire.VerifyAdmission(admission, signingKey)) throw new InvalidOperationException("Dynamic worker admission signature is invalid.");
    }
}
