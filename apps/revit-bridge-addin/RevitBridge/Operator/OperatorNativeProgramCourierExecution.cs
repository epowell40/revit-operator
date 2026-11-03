using System;
using System.Diagnostics;
using System.IO;
using System.Text;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using RevitBridge.Common;
using RevitOperator.DynamicRevitSdk;

namespace RevitBridge.Operator
{
    internal static class OperatorNativeProgramCourierExecution
    {
        internal static async Task<object> ExecuteAsync(string path, string body, string bridgeUrl, CancellationToken token)
        {
            if (!Uri.TryCreate(bridgeUrl, UriKind.Absolute, out var endpoint) || endpoint.Scheme != "http" || !endpoint.IsLoopback
                || !string.IsNullOrEmpty(endpoint.UserInfo) || endpoint.AbsolutePath != "/" || !string.IsNullOrEmpty(endpoint.Query))
                throw new InvalidOperationException("Current process native listener identity is unavailable.");
            var request = OperatorNativeProgramCourierRequest.Validate(path, body);
            var options = new JsonSerializerOptions { PropertyNamingPolicy = JsonNamingPolicy.CamelCase };
            var program = JsonSerializer.Deserialize<DynamicNativeProgramRequestV1>(request.GetProperty("nativeProgram").GetRawText(), options)!;
            program.Validate();
            var package = Path.Combine(Path.GetDirectoryName(typeof(OperatorNativeProgramCourierExecution).Assembly.Location)!, "dynamic-runtime");
            var supervisor = Path.Combine(package, "supervisor", "DynamicRevitSandboxSupervisor.exe");
            var worker = Path.Combine(package, "worker");
            if (!File.Exists(supervisor) || !File.Exists(Path.Combine(worker, "DynamicRevitWorker.exe")))
                throw new InvalidOperationException("Install the matching native C# runtime on this Revit workstation.");
            OperatorSecurity.GetOrCreateOperatorToken(); // Existing authenticated local bridge identity.
            var workspace = WorkspacePaths.GetWorkspaceRoot();
            var parent = Path.Combine(workspace, "artifacts", "dynamic-runtime-runs");
            Directory.CreateDirectory(parent);
            var run = Path.Combine(parent, "courier-" + Guid.NewGuid().ToString("N"));
            Directory.CreateDirectory(run);
            var source = Path.Combine(run, "program.cs");
            var config = Path.Combine(run, "task.json");
            var evidence = Path.Combine(run, "evidence.json");
            Process? process = null;
            var retainForReconciliation = false;
            try
            {
                File.WriteAllText(source, request.GetProperty("source").GetString(), new UTF8Encoding(false));
                File.WriteAllText(config, JsonSerializer.Serialize(new {
                    workerDirectory = worker, evidencePath = evidence, sourceFile = source,
                    bridgeUrl, operatorTokenFile = Path.Combine(workspace, "operator_token.txt"),
                    targetRevitYear = request.GetProperty("targetRevitYear").GetString(), limit = 200, parameters = Array.Empty<string>(), operationBudget = 32,
                    workerDeadlineMs = request.GetProperty("workerDeadlineMs").GetInt32(), applyDeadlineMs = 5000,
                    readOnly = program.Mode == "read", apply = program.Mode == "write", nativeProgram = program,
                    expectedDocumentFingerprint = request.GetProperty("expectedDocumentFingerprint").GetString()
                }, options), new UTF8Encoding(false));
                var start = new ProcessStartInfo(supervisor, "--execute-task \"" + config + "\"") {
                    UseShellExecute = false, CreateNoWindow = true, WorkingDirectory = package
                };
                start.EnvironmentVariables["REVIT_OPERATOR_MODE"] = "local";
                start.EnvironmentVariables["OPERATOR_TOOL_EXPOSURE_PROFILE"] = "general";
                start.EnvironmentVariables["OPERATOR_WORKSPACE_ROOT"] = workspace;
                token.ThrowIfCancellationRequested();
                process = Process.Start(start) ?? throw new InvalidOperationException("Native C# launcher did not start.");
                while (!process.HasExited) { token.ThrowIfCancellationRequested(); await Task.Delay(50, token).ConfigureAwait(false); }
                if (process.ExitCode != 0 && process.ExitCode != 1 || !File.Exists(evidence) || new FileInfo(evidence).Length > 8 * 1024 * 1024)
                    throw new InvalidOperationException("Native C# launcher has no bounded evidence. Reconcile before retrying.");
                using var result = JsonDocument.Parse(File.ReadAllText(evidence));
                var output = new { schema = "operator.native-program-workstation-result.v1", exitCode = process.ExitCode, evidence = result.RootElement.Clone() };
                if (JsonSerializer.SerializeToUtf8Bytes(output).Length > OperatorCourierResultCompactor.MaxTransportResultBytes)
                {
                    retainForReconciliation = true;
                    throw new InvalidOperationException("Native C# evidence exceeds courier transport capacity; exact evidence retained at " + evidence + ". Reconcile before retrying.");
                }
                return output;
            }
            finally
            {
                // No retry. A cancelled/lost write stays uncertain until native
                // reconciliation; terminating its launcher prevents a later dispatch.
                var exited = process == null;
                if (process != null) {
                    try { if (!process.HasExited) process.Kill(); process.WaitForExit(5000); exited = process.HasExited; } catch { }
                    process.Dispose();
                }
                // Source is retained on the backend before publication; actual
                // evidence is returned into the durable courier completion outbox.
                // Remove only our three known temporary regular files, never models.
                foreach (var file in exited && !retainForReconciliation ? new[] { source, config, evidence } : Array.Empty<string>())
                    try { if (File.Exists(file) && (File.GetAttributes(file) & FileAttributes.ReparsePoint) == 0) File.Delete(file); } catch { }
                if (exited && !retainForReconciliation) try { Directory.Delete(run, false); } catch { }
            }
        }
    }
}
