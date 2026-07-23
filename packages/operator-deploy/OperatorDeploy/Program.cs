using System.Text.Json;
using RevitOperator.Deployment;

if (args.Length == 0 || args[0] is "help" or "--help" or "-h")
{
    PrintUsage();
    return args.Length == 0 ? ExitCodes.InvalidArguments : ExitCodes.Success;
}

try
{
    var options = Parse(args);
    var result = new DeploymentEngine(new DeploymentContext(), options).Execute();
    Console.WriteLine(JsonSerializer.Serialize(result, ReleaseManifest.JsonOptions));
    return result.ExitCode;
}
catch (DeploymentException ex)
{
    Console.Error.WriteLine(ex.Message);
    PrintUsage();
    return ex.ExitCode;
}

static DeploymentOptions Parse(string[] values)
{
    var operation = values[0].Trim().ToLowerInvariant();
    string? manifest = null;
    string? logPath = null;
    string? revitVersion = null;
    var scope = "user";
    var quiet = false;
    var dryRun = false;
    var force = false;
    var bundleOnly = false;

    for (var i = 1; i < values.Length; i++)
    {
        switch (values[i].ToLowerInvariant())
        {
            case "--manifest": manifest = RequiredValue(values, ref i, "--manifest"); break;
            case "--log-path": logPath = RequiredValue(values, ref i, "--log-path"); break;
            case "--install-scope": scope = RequiredValue(values, ref i, "--install-scope").ToLowerInvariant(); break;
            case "--revit-version": revitVersion = RequiredValue(values, ref i, "--revit-version"); break;
            case "--quiet": quiet = true; break;
            case "--dry-run": dryRun = true; break;
            case "--force": force = true; break;
            case "--bundle-only": bundleOnly = true; break;
            default: throw new DeploymentException(ExitCodes.InvalidArguments, $"Unknown option '{values[i]}'.");
        }
    }

    return new DeploymentOptions
    {
        Operation = operation,
        ManifestPath = manifest,
        LogPath = logPath,
        RevitVersion = revitVersion,
        InstallScope = scope,
        Quiet = quiet,
        DryRun = dryRun,
        Force = force,
        BundleOnly = bundleOnly
    };
}

static string RequiredValue(string[] values, ref int index, string option)
{
    if (++index >= values.Length) throw new DeploymentException(ExitCodes.InvalidArguments, $"{option} requires a value.");
    return values[index];
}

static void PrintUsage()
{
    Console.WriteLine("""
Revit Operator transactional deployment utility

Usage:
  OperatorDeploy.exe install --manifest .\manifest.json
  OperatorDeploy.exe update --manifest .\manifest.json
  OperatorDeploy.exe validate [--manifest .\manifest.json --bundle-only]
  OperatorDeploy.exe repair --manifest .\manifest.json
  OperatorDeploy.exe rollback
  OperatorDeploy.exe status
  OperatorDeploy.exe diagnostics

Options:
  --manifest <path>          Release manifest path
  --quiet                    Suppress progress lines (JSON result is still printed)
  --dry-run                  Verify and plan without changing files
  --force                    Reserved for explicit recovery operations
  --log-path <path>          Override the deployment log path
  --install-scope user       Portable v1 supports per-user installation
  --revit-version <year>     Limit installation to one Revit version
  --bundle-only              Validate the release bundle rather than installed state
""");
}
