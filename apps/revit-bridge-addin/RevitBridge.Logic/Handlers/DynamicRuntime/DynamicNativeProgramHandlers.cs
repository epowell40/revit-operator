using System;
using System.Diagnostics;
using System.Linq;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using Autodesk.Revit.UI;
using RevitBridge.Common;
using RevitOperator.DynamicRevitSdk;

namespace RevitBridge.Logic.Handlers.DynamicRuntime
{
    internal sealed class DynamicNativePreparedProgram
    {
        internal string RuntimeId="",SourceHash="",EntryType="",Mode="";
        internal long ActiveViewId;
        internal DynamicNativeProgramScopeV1 Scope=new DynamicNativeProgramScopeV1();
        internal OperatorDocumentChangeVersion Version=null!;
    }

    internal static class DynamicNativeProgramWire
    {
        internal static readonly JsonSerializerOptions Json=new JsonSerializerOptions{PropertyNamingPolicy=JsonNamingPolicy.CamelCase};
        internal static void RequireSupportedHost()
        {
            OperatorNativeProgramExecution.RequireSupportedHost(
                Environment.GetEnvironmentVariable("OPERATOR_NATIVE_PROGRAM_EXECUTION"),
                Environment.GetEnvironmentVariable("REVIT_OPERATOR_MODE"),
                Environment.GetEnvironmentVariable("OPERATOR_TOOL_EXPOSURE_PROFILE"));
        }
        internal static void Exact(string json,params string[] fields)
        {
            using var document=JsonDocument.Parse(json);
            var names=document.RootElement.ValueKind==JsonValueKind.Object?document.RootElement.EnumerateObject().Select(p=>p.Name).ToArray():Array.Empty<string>();
            if(names.Length!=fields.Length || names.Distinct(StringComparer.Ordinal).Count()!=names.Length || names.Any(n=>!fields.Contains(n,StringComparer.Ordinal)))
                throw new ArgumentException("Native program request has missing, duplicate or unknown fields.");
        }
    }

    public sealed class DynamicNativeProgramPreparationHandler : IRequestHandler
    {
        private readonly Func<string,OperatorDocumentChangeVersion> _version;
        public DynamicNativeProgramPreparationHandler(Func<string,OperatorDocumentChangeVersion> version){_version=version??throw new ArgumentNullException(nameof(version));}
        private sealed class Request
        {
            public string runtimeInstanceId{get;set;}="";public string correlationId{get;set;}="";
            public long authExpiresUnixSeconds{get;set;} public string requestMac{get;set;}="";
            public string sourceHash{get;set;}="";public string expectedDocumentFingerprint{get;set;}="";
            public DynamicNativeProgramRequestV1 program{get;set;}=null!;
        }
        public Task<object> Handle(UIApplication app,string jsonData)
        {
            DynamicNativeProgramWire.RequireSupportedHost();
            DynamicNativeProgramWire.Exact(jsonData,"runtimeInstanceId","correlationId","authExpiresUnixSeconds","requestMac","sourceHash","expectedDocumentFingerprint","program");
            var request=JsonSerializer.Deserialize<Request>(jsonData,DynamicNativeProgramWire.Json)??throw new ArgumentException("Native preparation is invalid.");
            if(request.program==null)throw new ArgumentException("Native program description is missing.");request.program.Validate();
            var core=JsonSerializer.Serialize(new{request.sourceHash,request.expectedDocumentFingerprint,request.program},DynamicNativeProgramWire.Json);
            DynamicRuntimeBootstrapRegistry.VerifyRequest(request.runtimeInstanceId,"native-program-prepare",request.correlationId,request.authExpiresUnixSeconds,DynamicWire.Sha256(core),request.requestMac);
            DynamicRuntimeBootstrapRegistry.RequireLiveLauncher(request.runtimeInstanceId);
            var document=app.ActiveUIDocument?.Document??throw new InvalidOperationException("No active document.");
            if(request.expectedDocumentFingerprint!=DynamicRuntimeSnapshotHandler.Fingerprint(document))throw new InvalidOperationException("Native preparation document differs from the requested model.");
            var receipt=DynamicRuntimeSnapshotHandler.PrepareNativeProgram(app,request.runtimeInstanceId,request.sourceHash,request.program,_version);
            return Task.FromResult(DynamicRuntimeBootstrapRegistry.AuthenticateReceipt(request.runtimeInstanceId,"native-program-prepare-receipt",receipt));
        }
    }

    public sealed class DynamicNativeProgramExecutionHandler : IInteractiveRequestHandler
    {
        private readonly Func<string,OperatorDocumentChangeVersion> _version;
        private readonly bool _readOnly;
        public DynamicNativeProgramExecutionHandler(Func<string,OperatorDocumentChangeVersion> version,bool readOnly)
        {_version=version??throw new ArgumentNullException(nameof(version));_readOnly=readOnly;}
        private sealed class Request
        {
            public string runtimeInstanceId{get;set;}="";public string correlationId{get;set;}="";
            public long authExpiresUnixSeconds{get;set;} public string requestMac{get;set;}="";
            public string preparationId{get;set;}="";public DynamicNativeProgramArtifactV1 artifact{get;set;}=null!;
            public DynamicWorkerAdmission admission{get;set;}=null!;
        }
        public Task<object> Handle(UIApplication app,string jsonData)=>throw new InvalidOperationException("Native program requires the existing dispatch cancellation context.");
        public Task<object> HandleInteractive(UIApplication app,string jsonData,CancellationToken cancellationToken)
        {
            DynamicNativeProgramWire.RequireSupportedHost();cancellationToken.ThrowIfCancellationRequested();
            DynamicNativeProgramWire.Exact(jsonData,"runtimeInstanceId","correlationId","authExpiresUnixSeconds","requestMac","preparationId","artifact","admission");
            var request=JsonSerializer.Deserialize<Request>(jsonData,DynamicNativeProgramWire.Json)??throw new ArgumentException("Native execution request is invalid.");
            if(request.artifact==null || request.admission==null || request.admission.RuntimeInstanceId!=request.runtimeInstanceId)
                throw new ArgumentException("Native execution artifact/admission is missing or foreign.");
            if(request.artifact.Mode!=(_readOnly?"read":"write"))throw new InvalidOperationException("Native program mode differs from the admitted transport lane.");
            _=DynamicNativeProgramArtifactPolicyV1.ArtifactHash(request.artifact);
            var core=JsonSerializer.Serialize(new{request.preparationId,request.artifact,request.admission},DynamicNativeProgramWire.Json);
            DynamicRuntimeBootstrapRegistry.VerifyRequest(request.runtimeInstanceId,"native-program-execute",request.correlationId,request.authExpiresUnixSeconds,DynamicWire.Sha256(core),request.requestMac);
            DynamicRuntimeBootstrapRegistry.RequireLiveLauncher(request.runtimeInstanceId);
            var prepared=DynamicRuntimeSnapshotHandler.ConsumeNativeProgram(app,request.runtimeInstanceId,request.preparationId,request.artifact,_version);
            var poll=Stopwatch.StartNew();long lastLauncherPoll=-25;
            void RequireCurrentExecution()
            {
                cancellationToken.ThrowIfCancellationRequested();
                if(DateTimeOffset.UtcNow.ToUnixTimeSeconds()>request.authExpiresUnixSeconds)
                    throw new OperationCanceledException("Native execution request authorization expired.");
                if(poll.ElapsedMilliseconds-lastLauncherPoll>=25)
                {DynamicRuntimeBootstrapRegistry.RequireLiveLauncher(request.runtimeInstanceId);lastLauncherPoll=poll.ElapsedMilliseconds;}
            }
            var result=DynamicNativeProgramRevitHost.Execute(app,request.artifact,prepared.Scope,request.admission,
                prepared.Version.Sequence,prepared.Scope.NativeScopeHash,RequireCurrentExecution);
            result["schema"]="dynamic-revit-native-execution-receipt/v1";
            result["preparation_id"]=request.preparationId;
            return Task.FromResult(DynamicRuntimeBootstrapRegistry.AuthenticateReceipt(request.runtimeInstanceId,"native-program-execute-receipt",result));
        }
    }
}
