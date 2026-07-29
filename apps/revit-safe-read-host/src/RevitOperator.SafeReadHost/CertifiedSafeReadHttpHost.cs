using System;
using System.Net;
using System.Threading;
using System.Threading.Tasks;
using Autodesk.Revit.UI;
using RevitOperator.SafeReadCertifiedExecution;
using RevitOperator.SafeReadHost.HostKernel;

namespace RevitOperator.SafeReadHost
{
    internal sealed class CertifiedSafeReadHttpHost
    {
        private readonly InstanceIdentity _identity;private readonly DocumentSessionTracker _tracker;private readonly CertifiedExternalWorkSlot _slot;private readonly ExternalEvent _event;private readonly SafeReadBackendAuthorizer _authorizer;private readonly RuntimeDeploymentAttestation _attestation;private readonly SingleFlightGate _gate=new SingleFlightGate();private readonly CancellationTokenSource _shutdown=new CancellationTokenSource();private HttpListener? _listener;
        public CertifiedSafeReadHttpHost(InstanceIdentity identity,DocumentSessionTracker tracker,CertifiedExternalWorkSlot slot,ExternalEvent externalEvent,SafeReadBackendAuthorizer authorizer,RuntimeDeploymentAttestation attestation){_identity=identity;_tracker=tracker;_slot=slot;_event=externalEvent;_authorizer=authorizer;_attestation=attestation;}
        public string? Endpoint{get;private set;}
        public bool Start(bool hasPort,int configuredPort)
        {
            int first=hasPort?configuredPort:SafeReadContract.MinimumPort,last=hasPort?configuredPort:SafeReadContract.MaximumPort;
            for(int port=first;port<=last;port++){if(!PortPolicy.IsAllowed(port))return false;HttpListener listener=new HttpListener();string prefix="http://127.0.0.1:"+port.ToString(System.Globalization.CultureInfo.InvariantCulture)+"/";listener.Prefixes.Add(prefix);try{listener.Start();_listener=listener;Endpoint=prefix.TrimEnd('/');_ = AcceptLoop();return true;}catch{listener.Close();}}
            return false;
        }
        public void Stop(){_shutdown.Cancel();HttpListener? listener=Interlocked.Exchange(ref _listener,null);if(listener!=null){try{listener.Stop();}catch{}listener.Close();}_slot.FailPending(CertifiedFailureCode.RevitUnavailable);}
        private async Task AcceptLoop(){while(!_shutdown.IsCancellationRequested){HttpListener? listener=_listener;if(listener==null||!listener.IsListening)return;try{HttpListenerContext context=await listener.GetContextAsync().ConfigureAwait(false);_ = Process(context);}catch{if(_shutdown.IsCancellationRequested)return;}}}
        private async Task Process(HttpListenerContext context)
        {
            bool held=false;string requestId=String.Empty,attemptId=String.Empty;CertifiedExecutionPhase phase=CertifiedExecutionPhase.None;CertifiedExecutionOutcome outcome=CertifiedExecutionOutcome.Pending;
            using(CancellationTokenSource deadline=CancellationTokenSource.CreateLinkedTokenSource(_shutdown.Token))
            {
                deadline.CancelAfter(SafeReadContract.RequestDeadline);
                try
                {
                    RequestFacts facts=await RequestFactsReader.ReadAsync(context.Request,deadline.Token).ConfigureAwait(false);requestId=facts.RequestId;attemptId=facts.AttemptId;
                    DocumentBinding? current=_tracker.Current;CertifiedFailureCode admission=RequestAdmission.Evaluate(facts,_identity,current);
                    if(admission!=CertifiedFailureCode.None){outcome=admission==CertifiedFailureCode.Unauthorized?CertifiedExecutionOutcome.Denied:CertifiedExecutionOutcome.Failed;await Write(context.Response,ResponsePayload.Failure(admission,phase,outcome,requestId,attemptId)).ConfigureAwait(false);return;}
                    if(!_gate.TryEnter()){await Write(context.Response,ResponsePayload.Failure(CertifiedFailureCode.Busy,phase,CertifiedExecutionOutcome.Failed,requestId,attemptId)).ConfigureAwait(false);return;}held=true;
                    CertifiedExecutionResult captured=await Dispatch(CertifiedExternalWorkItem.Capture(current!),deadline.Token).ConfigureAwait(false);phase=CertifiedExecutionPhase.CaptureBinding;
                    if(!captured.Succeeded||captured.Binding==null){await Write(context.Response,ResponsePayload.Failure(captured.FailureCode,captured.Phase,captured.Outcome,requestId,attemptId)).ConfigureAwait(false);return;}
                    AuthorizationBindings bindings=new AuthorizationBindings(SafeReadContract.RouteId,_identity.HostInstanceId,SafeReadContract.ExecutorId,_attestation.Sha256,_attestation.RuntimeTuple,captured.Binding.ProjectFingerprint,captured.Binding.DocumentSessionId,facts.ClientSession,facts.RequestId,facts.AttemptId);
                    byte[] nonce=Protocol.NewNonce();VerifiedFinalAuthorizationToken? token;try{token=await _authorizer.AuthorizeAsync(bindings,nonce,deadline.Token).ConfigureAwait(false);}finally{Array.Clear(nonce,0,nonce.Length);}
                    phase=CertifiedExecutionPhase.VerifyFinalReceipt;if(token==null){await Write(context.Response,ResponsePayload.Failure(CertifiedFailureCode.AuthorizationUnavailable,phase,CertifiedExecutionOutcome.Denied,requestId,attemptId)).ConfigureAwait(false);return;}
                    phase=CertifiedExecutionPhase.CountSheets;CertifiedExecutionResult counted=await Dispatch(CertifiedExternalWorkItem.Count(captured.Binding,token),deadline.Token).ConfigureAwait(false);
                    if(!counted.Succeeded){await Write(context.Response,ResponsePayload.Failure(counted.FailureCode,counted.Phase,counted.Outcome,requestId,attemptId)).ConfigureAwait(false);return;}
                    phase=CertifiedExecutionPhase.Completed;outcome=CertifiedExecutionOutcome.Succeeded;await Write(context.Response,ResponsePayload.Success(counted.Count,requestId,attemptId)).ConfigureAwait(false);
                }
                catch(OperationCanceledException){outcome=CertifiedExecutionOutcome.Cancelled;await TryWrite(context.Response,ResponsePayload.Failure(CertifiedFailureCode.DeadlineExceeded,phase,outcome,requestId,attemptId)).ConfigureAwait(false);}
                catch{outcome=CertifiedExecutionOutcome.Failed;await TryWrite(context.Response,ResponsePayload.Failure(CertifiedFailureCode.InternalFailure,phase,outcome,requestId,attemptId)).ConfigureAwait(false);}
                finally{if(held)_gate.Exit();try{context.Response.Close();}catch{}}
            }
        }
        private async Task<CertifiedExecutionResult> Dispatch(CertifiedExternalWorkItem item,CancellationToken cancellation)
        {
            if(!_slot.TryQueue(item))return CertifiedExecutionResult.Failure(item.Phase,CertifiedFailureCode.Busy);
            if(_event.Raise()!=ExternalEventRequest.Accepted){_slot.FailPending(CertifiedFailureCode.RevitUnavailable);return await item.Completion.ConfigureAwait(false);}
            Task completed=await Task.WhenAny(item.Completion,Task.Delay(Timeout.Infinite,cancellation)).ConfigureAwait(false);
            if(completed==item.Completion)return await item.Completion.ConfigureAwait(false);
            if(_slot.TryCancelPending(item))return await item.Completion.ConfigureAwait(false);
            // The Revit handler already claimed the item. The HTTP gate may be
            // released, but the certified capacity-one slot remains occupied until
            // the handler terminates, so another read can never overlap it.
            return CertifiedExecutionResult.Cancelled(item.Phase);
        }
        private static async Task Write(HttpListenerResponse response,ResponsePayload payload){response.StatusCode=payload.StatusCode;response.ContentType="application/json; charset=utf-8";response.SendChunked=false;response.KeepAlive=false;response.ContentLength64=payload.Body.Length;response.Headers["Cache-Control"]="no-store";await response.OutputStream.WriteAsync(payload.Body,0,payload.Body.Length).ConfigureAwait(false);}
        private static async Task TryWrite(HttpListenerResponse response,ResponsePayload payload){try{await Write(response,payload).ConfigureAwait(false);}catch{}}
    }
}
