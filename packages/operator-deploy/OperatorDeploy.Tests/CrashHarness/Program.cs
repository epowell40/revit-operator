using System.Text.Json;
using RevitOperator.Deployment;

var input = JsonSerializer.Deserialize<HarnessInput>(Convert.FromBase64String(args.Single()))
    ?? throw new InvalidDataException("Crash harness input was empty.");
var context = new DeploymentContext
{
    LocalAppData = input.LocalAppData,
    AppData = input.AppData,
    Desktop = input.Desktop,
    ProgramFiles = input.ProgramFiles,
    CommonAppData = input.CommonAppData,
    WindowsVersion = new Version(10, 0, 19045),
    IsRevitRunning = () => false,
    GetEnvironmentVariable = _ => null,
    ActivationCheckpoint = point =>
    {
        if (point == input.KillPoint) Environment.Exit(137);
    }
};
var result = new DeploymentEngine(context, new DeploymentOptions
{
    Operation = input.Operation,
    ManifestPath = input.ManifestPath,
    SafeReadAdmissionReceiptPath = input.SafeReadAdmissionReceiptPath,
    SafeReadAdmissionReceiptSha256 = input.SafeReadAdmissionReceiptSha256,
    SafeReadPackagePinSha256 = input.SafeReadPackagePinSha256,
    Quiet = true
}, TextWriter.Null).Execute();
return result.ExitCode;

internal sealed record HarnessInput(
    string LocalAppData,
    string AppData,
    string Desktop,
    string ProgramFiles,
    string CommonAppData,
    string Operation,
    string? ManifestPath,
    string? SafeReadAdmissionReceiptPath,
    string? SafeReadAdmissionReceiptSha256,
    string? SafeReadPackagePinSha256,
    string KillPoint);
