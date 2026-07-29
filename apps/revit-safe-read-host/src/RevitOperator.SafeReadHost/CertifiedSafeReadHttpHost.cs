using System;
using System.Net;
using System.Threading;
using System.Threading.Tasks;
using Autodesk.Revit.UI;
using RevitOperator.SafeReadHost.HostKernel;

namespace RevitOperator.SafeReadHost
{
    internal sealed class CertifiedSafeReadHttpHost
    {
        private readonly InstanceIdentity _identity;
        private readonly DocumentSessionTracker _tracker;
        private readonly CertifiedExternalWorkSlot _slot;
        private readonly CertifiedExternalEventDispatcher _dispatcher;
        private readonly SafeReadBackendAuthorizer _authorizer;
        private readonly RuntimeDeploymentAttestation _attestation;
        private readonly BackendAuthorizationCoordinator _authorizationCoordinator = new BackendAuthorizationCoordinator(SafeReadContract.AuthorizationDeadline);
        private readonly SingleFlightGate _gate = new SingleFlightGate();
        private readonly CancellationTokenSource _shutdown = new CancellationTokenSource();
        private HttpListener? _listener;

        public CertifiedSafeReadHttpHost(InstanceIdentity identity, DocumentSessionTracker tracker, CertifiedExternalWorkSlot slot, ExternalEvent externalEvent, SafeReadBackendAuthorizer authorizer, RuntimeDeploymentAttestation attestation)
        {
            _identity = identity;
            _tracker = tracker;
            _slot = slot;
            _dispatcher = new CertifiedExternalEventDispatcher(slot, new RevitExternalEventRaiser(externalEvent));
            _authorizer = authorizer;
            _attestation = attestation;
        }

        public string? Endpoint { get; private set; }

        public bool Start(bool hasPort, int configuredPort)
        {
            int first = hasPort ? configuredPort : SafeReadContract.MinimumPort;
            int last = hasPort ? configuredPort : SafeReadContract.MaximumPort;
            for (int port = first; port <= last; port++)
            {
                if (!PortPolicy.IsAllowed(port)) return false;
                HttpListener listener = new HttpListener();
                string prefix = "http://127.0.0.1:" + port.ToString(System.Globalization.CultureInfo.InvariantCulture) + "/";
                listener.Prefixes.Add(prefix);
                try
                {
                    listener.Start();
                    _listener = listener;
                    Endpoint = prefix;
                    _ = AcceptLoop();
                    return true;
                }
                catch { listener.Close(); }
            }
            return false;
        }

        public void Stop()
        {
            _shutdown.Cancel();
            HttpListener? listener = Interlocked.Exchange(ref _listener, null);
            if (listener != null)
            {
                try { listener.Stop(); } catch { }
                listener.Close();
            }
            _slot.FailPending(CertifiedFailureCode.RevitUnavailable);
        }

        private async Task AcceptLoop()
        {
            while (!_shutdown.IsCancellationRequested)
            {
                HttpListener? listener = _listener;
                if (listener == null || !listener.IsListening) return;
                try
                {
                    HttpListenerContext context = await listener.GetContextAsync().ConfigureAwait(false);
                    _ = Process(context);
                }
                catch { if (_shutdown.IsCancellationRequested) return; }
            }
        }

        private async Task Process(HttpListenerContext context)
        {
            bool held = false;
            CertifiedExecutionPhase phase = CertifiedExecutionPhase.None;
            bool requestDispatched = false;
            bool outcomeUnknown = false;
            using (CancellationTokenSource deadline = CancellationTokenSource.CreateLinkedTokenSource(_shutdown.Token))
            {
                deadline.CancelAfter(SafeReadContract.RequestDeadline);
                try
                {
                    RequestFacts facts = await RequestFactsReader.ReadAsync(context.Request, deadline.Token).ConfigureAwait(false);
                    DocumentBinding? current = _tracker.Current;
                    CertifiedFailureCode admission = RequestAdmission.Evaluate(facts, _identity, current);
                    if (admission != CertifiedFailureCode.None)
                    {
                        await Write(context.Response, ResponsePayload.Failure(admission, phase, false, false)).ConfigureAwait(false);
                        return;
                    }
                    if (!_gate.TryEnter())
                    {
                        await Write(context.Response, ResponsePayload.Failure(CertifiedFailureCode.Busy, phase, false, false)).ConfigureAwait(false);
                        return;
                    }
                    held = true;

                    phase = CertifiedExecutionPhase.CaptureBinding;
                    CertifiedExecutionResult captured = await Dispatch(CertifiedExternalWorkItem.Capture(current!), deadline.Token).ConfigureAwait(false);
                    requestDispatched = captured.RequestDispatched;
                    outcomeUnknown = captured.OutcomeUnknown;
                    if (!captured.Succeeded || captured.Binding == null)
                    {
                        await Write(context.Response, ResponsePayload.Failure(captured.FailureCode, captured.Phase, captured.RequestDispatched, captured.OutcomeUnknown)).ConfigureAwait(false);
                        return;
                    }

                    AuthorizationBindings bindings = new AuthorizationBindings(SafeReadContract.RouteId, _identity.HostInstanceId, SafeReadContract.ExecutorId, _attestation.Sha256, _attestation.RuntimeTuple, captured.Binding.ProjectFingerprint, captured.Binding.DocumentSessionId, facts.ClientSession, facts.RequestId, facts.AttemptId);
                    byte[] nonce = Protocol.NewNonce();
                    BackendAuthorizationResult authorization;
                    phase = CertifiedExecutionPhase.VerifyFinalReceipt;
                    try { authorization = await _authorizationCoordinator.AuthorizeAsync(_authorizer, bindings, nonce, deadline.Token).ConfigureAwait(false); }
                    finally { Array.Clear(nonce, 0, nonce.Length); }

                    if (authorization.Token == null)
                    {
                        await Write(context.Response, ResponsePayload.AuthorizationFailure(authorization.Failure ?? BackendAuthorizationFailure.Unavailable())).ConfigureAwait(false);
                        return;
                    }

                    phase = CertifiedExecutionPhase.CountSheets;
                    CertifiedExecutionResult counted = await Dispatch(CertifiedExternalWorkItem.Count(captured.Binding, authorization.Token), deadline.Token).ConfigureAwait(false);
                    requestDispatched = counted.RequestDispatched;
                    outcomeUnknown = counted.OutcomeUnknown;
                    if (!counted.Succeeded)
                    {
                        await Write(context.Response, ResponsePayload.Failure(counted.FailureCode, counted.Phase, counted.RequestDispatched, counted.OutcomeUnknown)).ConfigureAwait(false);
                        return;
                    }
                    phase = CertifiedExecutionPhase.Completed;
                    await Write(context.Response, ResponsePayload.Success(counted.Count)).ConfigureAwait(false);
                }
                catch (OperationCanceledException)
                {
                    await TryWrite(context.Response, ResponsePayload.Failure(CertifiedFailureCode.DeadlineExceeded, phase, requestDispatched, outcomeUnknown)).ConfigureAwait(false);
                }
                catch
                {
                    await TryWrite(context.Response, ResponsePayload.Failure(CertifiedFailureCode.InternalFailure, phase, false, false)).ConfigureAwait(false);
                }
                finally
                {
                    if (held) _gate.Exit();
                    try { context.Response.Close(); } catch { }
                }
            }
        }

        private async Task<CertifiedExecutionResult> Dispatch(CertifiedExternalWorkItem item, CancellationToken cancellation)
        {
            return await _dispatcher.DispatchAsync(item, cancellation).ConfigureAwait(false);
        }

        private static async Task Write(HttpListenerResponse response, ResponsePayload payload)
        {
            response.StatusCode = payload.StatusCode;
            response.ContentType = "application/json; charset=utf-8";
            response.SendChunked = false;
            response.KeepAlive = false;
            response.ContentLength64 = payload.Body.Length;
            response.Headers["Cache-Control"] = "no-store";
            await response.OutputStream.WriteAsync(payload.Body, 0, payload.Body.Length).ConfigureAwait(false);
        }

        private static async Task TryWrite(HttpListenerResponse response, ResponsePayload payload)
        {
            try { await Write(response, payload).ConfigureAwait(false); } catch { }
        }
    }
}
