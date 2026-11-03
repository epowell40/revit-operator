using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Linq;
using System.Reflection;
using System.Runtime.ExceptionServices;
using System.Threading;
using Autodesk.Revit.DB;
using Autodesk.Revit.DB.Events;
using Autodesk.Revit.UI;
using RevitBridge.Common;
using RevitOperator.DynamicRevitSdk;

namespace RevitBridge.Logic.Handlers.DynamicRuntime
{
    // Internal host adapter, not an HTTP route. The existing trusted launcher and
    // current native-scope authority must supply the pinned references/revision/
    // scope and Pause callback. Generated program output is never semantic proof.
    internal static class DynamicNativeProgramRevitHost
    {
        private static readonly object CacheGate=new object();
        private static readonly Dictionary<string,MethodInfo> Entries=new Dictionary<string,MethodInfo>(StringComparer.Ordinal);
        private const int MaximumLoadedPrograms=64; // NET48 cannot unload individual assemblies.

        internal static Dictionary<string,object?> Execute(UIApplication app, DynamicNativeProgramArtifactV1 artifact,
            DynamicNativeProgramScopeV1 scope, DynamicWorkerAdmission admission,
            long currentNativeRevision,
            string currentNativeScopeHash, Action requireCurrentExecution)
        {
            if(requireCurrentExecution==null)throw new ArgumentNullException(nameof(requireCurrentExecution));
            requireCurrentExecution();
            var document=app.ActiveUIDocument?.Document ?? throw new InvalidOperationException("Native program requires an active document.");
            if(document.IsModifiable || artifact.Mode=="write" && document.IsReadOnly)throw new InvalidOperationException("Native program requires an idle host document, writable for write mode; no nested transaction.");
            var fingerprint=DynamicRuntimeSnapshotHandler.Fingerprint(document);var session=DynamicRuntimeSnapshotHandler.Session(document);
            var trustedReferences=DynamicRuntimeTrustBoundary.NativeTargetReferences();
            var binding=DynamicNativeProgramArtifactPolicyV1.ValidateCurrentBinding(artifact,scope,trustedReferences,
                admission.SourceHash,fingerprint,session,currentNativeRevision,currentNativeScopeHash);
            DynamicNativeProgramArtifactPolicyV1.ValidateHostApiVersion(artifact, typeof(Document).Assembly.GetName().Version);
            DynamicRuntimeAdmissionRegistry.VerifyAndConsume(admission,artifact.SourceHash,artifact.AssemblyHash,
                DynamicRevitSdkVersion.ManifestHash,binding,fingerprint,session);
            if(!DynamicAdmissionReplayLedger.TryConsume(DynamicWire.Sha256("native-program/v1\n"+admission.RuntimeInstanceId+"\n"+admission.CorrelationId),admission.ExpiresUnixSeconds))
                throw new InvalidOperationException("Native program admission was already consumed.");
            var entry=LoadTrustedEntry(artifact);var thread=Thread.CurrentThread.ManagedThreadId;var clock=Stopwatch.StartNew();
            void Checkpoint()
            {
                if(Thread.CurrentThread.ManagedThreadId!=thread)throw new InvalidOperationException("Native program left its admitted Revit thread.");
                requireCurrentExecution();
                if(clock.ElapsedMilliseconds>scope.DeadlineMs)throw new TimeoutException("Native program exceeded its cooperative execution deadline.");
                var active=app.ActiveUIDocument?.Document;
                if(active==null || DynamicRuntimeSnapshotHandler.Fingerprint(active)!=fingerprint || DynamicRuntimeSnapshotHandler.Session(active)!=session)
                    throw new InvalidOperationException("Native program active document changed.");
            }
            string Invoke()
            {
                Checkpoint();
                try {return OperatorNativeProgramExecution.ValidateResult((string)entry.Invoke(null,new object[]{document,(Action)Checkpoint})!);}
                catch(TargetInvocationException ex) when(ex.InnerException!=null){ExceptionDispatchInfo.Capture(ex.InnerException).Throw();throw;}
            }
            Dictionary<string,object?> result;
            if(artifact.Mode=="read")
            {
                // No transaction is opened. Revit itself denies model mutations
                // outside a transaction, in addition to compiler read admission.
                try {result=new Dictionary<string,object?>{["success"]=true,["program_result"]=Invoke(),["read_only"]=true,["transaction"]=OperatorNativeTransactionReceipt.NotStarted()};}
                catch(Exception ex){result=new Dictionary<string,object?>{["success"]=false,["error"]=ex.Message,["read_only"]=true,["transaction"]=OperatorNativeTransactionReceipt.NotStarted()};}
            }
            else result=Write(app,document,scope,Invoke,Checkpoint);
            result["source_hash"]=artifact.SourceHash;result["assembly_hash"]=artifact.AssemblyHash;
            result["native_binding_hash"]=binding;result["document_fingerprint"]=fingerprint;result["document_session_id"]=session;
            result["document_revision_before"]=currentNativeRevision;result["elapsed_milliseconds"]=clock.ElapsedMilliseconds;
            result["retry_permitted"]=false;result["verified"]=false;
            result["effect_scope"]=scope.EffectScope;
            result["result_semantics"]="program_return_value_requires_task_specific_native_readback";
            return result;
        }

        private static Dictionary<string,object?> Write(UIApplication app,Document document,DynamicNativeProgramScopeV1 scope,
            Func<string> program,Action checkpoint)
        {
            var added=new HashSet<long>();var modified=new HashSet<long>();var deleted=new HashSet<long>();
            var failures=new List<DynamicCapturedFailure>();string? eventFailure=null;bool observing=false,observedCommit=false;
            var activeDocumentScope=scope.EffectScope=="active_document";
            // Preserve the existing pinned/grouped protection without asking
            // generated code to discover or predict dependent affected IDs.
            long[]? protectedExisting=null;
            if(activeDocumentScope)
            {
                checkpoint();
                using(var collector=new FilteredElementCollector(document))
                    protectedExisting=collector.WhereElementIsNotElementType().Where(e=>e.Pinned || e.GroupId!=ElementId.InvalidElementId)
                        .Select(e=>ElementIdCompat.GetValue(e.Id)).ToArray();
                checkpoint();
            }
            var fingerprint=DynamicRuntimeSnapshotHandler.Fingerprint(document);var session=DynamicRuntimeSnapshotHandler.Session(document);
            EventHandler<DocumentChangedEventArgs> changed=(sender,args)=>
            {
                if(!observing)return;
                try
                {
                    var changedDocument=args.GetDocument();
                    if(DynamicRuntimeSnapshotHandler.Fingerprint(changedDocument)!=fingerprint || DynamicRuntimeSnapshotHandler.Session(changedDocument)!=session)return;
                    observedCommit=true;
                    added.UnionWith(args.GetAddedElementIds().Select(ElementIdCompat.GetValue));
                    modified.UnionWith(args.GetModifiedElementIds().Select(ElementIdCompat.GetValue));
                    deleted.UnionWith(args.GetDeletedElementIds().Select(ElementIdCompat.GetValue));
                }
                catch(Exception ex){eventFailure=ex.Message;}
            };
            var group=new TransactionGroup(document,"Operator native program");var transaction=new Transaction(document,"Operator native program body");
            IEnumerable<long> Captured(HashSet<long> ids)
            {if(eventFailure!=null)throw new InvalidOperationException("Native program change inventory failed: "+eventFailure);
                if(!observedCommit)throw new InvalidOperationException("Native program commit has no scoped DocumentChanged receipt.");
                return ids.OrderBy(id=>id).ToArray();}
            var result=OperatorNativeTransactionExecution.ExecuteWithCleanup(()=>OperatorNativeProgramExecution.ExecuteWrite(
                ()=>
                {
                    checkpoint();if(group.Start()!=TransactionStatus.Started)throw new InvalidOperationException("Native program group did not start.");
                    app.Application.DocumentChanged+=changed;
                    var status=transaction.Start();
                    if(status==TransactionStatus.Started)transaction.SetFailureHandlingOptions(DynamicFailureHandlingUtil.ConfigureFailureCapture(transaction,failures));
                    return status.ToString();
                },()=>
                {
                    checkpoint();observing=true;
                    try{return transaction.Commit().ToString();}finally{observing=false;}
                },()=>{checkpoint();return group.Assimilate().ToString();},()=>
                {
                    observing=false;
                    if(transaction.GetStatus()==TransactionStatus.Started && transaction.RollBack()!=TransactionStatus.RolledBack)
                        throw new InvalidOperationException("Native program inner rollback failed.");
                    if(transaction.GetStatus()==TransactionStatus.Pending)throw new InvalidOperationException("Native program transaction remains pending.");
                    return group.GetStatus()==TransactionStatus.Started?group.RollBack().ToString():group.GetStatus().ToString();
                },()=>group.GetStatus().ToString(),()=>{var value=program();document.Regenerate();return value;},
                ()=>Captured(added),()=>Captured(modified),()=>Captured(deleted),scope.AllowedExistingElementIds,scope.AllowCreate,scope.MaxAffectedElements,
                activeDocumentScope,protectedExisting),()=>
                {
                    observing=false;app.Application.DocumentChanged-=changed;
                    try{transaction.Dispose();}finally{group.Dispose();}
                });
            result["native_failures"]=failures;return result;
        }

        private static MethodInfo LoadTrustedEntry(DynamicNativeProgramArtifactV1 artifact)
        {
            lock(CacheGate)
            {
                if(Entries.TryGetValue(artifact.AssemblyHash,out var cached))return cached;
                if(Entries.Count>=MaximumLoadedPrograms)throw new InvalidOperationException("Native program assembly capacity reached; Revit requires a normal close and restart before loading more distinct programs.");
                // Only authenticated compiler bytes reach this call. Never load
                // arbitrary user-supplied DLLs or call the uninstrumented entry.
                var assembly=Assembly.Load(artifact.Assembly);
                var boundary=assembly.GetType("RevitOperator.Generated.NativeExecutionBoundaryV1",true)!;
                var method=boundary.GetMethod("Run",BindingFlags.Public|BindingFlags.Static,null,new[]{typeof(Document),typeof(Action)},null);
                if(method==null || method.ReturnType!=typeof(string))throw new InvalidOperationException("Native program omitted its compiler-owned checkpoint boundary.");
                Entries.Add(artifact.AssemblyHash,method);return method;
            }
        }
    }
}
