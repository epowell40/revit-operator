using System;
using System.Net;
using System.Threading;
using System.Threading.Tasks;
using Autodesk.Revit.UI;
using RevitOperator.SafeReadHost.Kernel;

namespace RevitOperator.SafeReadHost
{
    internal sealed class SafeReadHttpHost
    {
        private readonly InstanceIdentity _identity;
        private readonly DocumentSessionTracker _documentTracker;
        private readonly CertifiedExternalWorkSlot _workSlot;
        private readonly ExternalEvent _externalEvent;
        private readonly SafeReadAuthorizationGate _authorizationGate;
        private readonly string? _runtimeAttestationSha256;
        private readonly RuntimeAttestationTuple? _runtimeAttestation;
        private readonly SingleFlightGate _singleFlight = new SingleFlightGate();
        private readonly CancellationTokenSource _shutdown = new CancellationTokenSource();
        private HttpListener? _listener;
        private Task? _acceptLoop;

        public SafeReadHttpHost(
            InstanceIdentity identity,
            DocumentSessionTracker documentTracker,
            CertifiedExternalWorkSlot workSlot,
            ExternalEvent externalEvent,
            SafeReadAuthorizationGate authorizationGate,
            string? runtimeAttestationSha256,
            RuntimeAttestationTuple? runtimeAttestation)
        {
            _identity = identity ?? throw new ArgumentNullException(nameof(identity));
            _documentTracker = documentTracker ?? throw new ArgumentNullException(nameof(documentTracker));
            _workSlot = workSlot ?? throw new ArgumentNullException(nameof(workSlot));
            _externalEvent = externalEvent ?? throw new ArgumentNullException(nameof(externalEvent));
            _authorizationGate = authorizationGate ?? throw new ArgumentNullException(nameof(authorizationGate));
            _runtimeAttestationSha256 = runtimeAttestationSha256;
            _runtimeAttestation = runtimeAttestation;
        }

        public string? BaseUrl { get; private set; }

        public bool Start(bool hasPortOverride, int portOverride)
        {
            if (_listener != null)
                return false;
            int first = hasPortOverride ? portOverride : SafeReadContract.MinimumPort;
            int last = hasPortOverride ? portOverride : SafeReadContract.MaximumPort;
            for (int port = first; port <= last; port++)
            {
                if (!PortPolicy.IsAllowed(port))
                    return false;
                HttpListener candidate = new HttpListener();
                string prefix = "http://127.0.0.1:" + port.ToString(System.Globalization.CultureInfo.InvariantCulture) + "/";
                candidate.Prefixes.Add(prefix);
                try
                {
                    candidate.Start();
                    _listener = candidate;
                    BaseUrl = prefix;
                    _acceptLoop = AcceptLoopAsync();
                    return true;
                }
                catch
                {
                    candidate.Close();
                }
            }
            return false;
        }

        public void Stop()
        {
            _shutdown.Cancel();
            HttpListener? listener = _listener;
            _listener = null;
            if (listener != null)
            {
                try
                {
                    listener.Stop();
                }
                catch
                {
                }
                listener.Close();
            }
            _workSlot.FailPending(FailureCode.RevitUnavailable);
        }

        private async Task AcceptLoopAsync()
        {
            while (!_shutdown.IsCancellationRequested)
            {
                HttpListener? listener = _listener;
                if (listener == null || !listener.IsListening)
                    return;
                HttpListenerContext context;
                try
                {
                    context = await listener.GetContextAsync().ConfigureAwait(false);
                }
                catch
                {
                    if (_shutdown.IsCancellationRequested)
                        return;
                    continue;
                }
                ProcessContextAsync(context);
            }
        }

        private async void ProcessContextAsync(HttpListenerContext context)
        {
            bool gateHeld = false;
            CertifiedRequestStateMachine state = new CertifiedRequestStateMachine();
            try
            {
                CertifiedRequestFacts facts = await HttpListenerRequestFactsReader.ReadAsync(context.Request).ConfigureAwait(false);
                DocumentBinding? currentDocument = _documentTracker.Current;
                AdmissionDecision admission = CertifiedRequestAdmission.Evaluate(facts, _identity, currentDocument);
                if (!admission.Accepted)
                {
                    await WriteResponseAsync(context.Response, ResponsePayload.Failure(admission.FailureCode)).ConfigureAwait(false);
                    return;
                }
                state.TryAdvance(CertifiedRequestState.WireAdmitted);

                if (!_singleFlight.TryEnter())
                {
                    await WriteResponseAsync(context.Response, ResponsePayload.Failure(FailureCode.Busy)).ConfigureAwait(false);
                    return;
                }
                gateHeld = true;
                state.TryAdvance(CertifiedRequestState.SlotAcquired);

                ResponsePayload response = await ExecuteCertifiedRequestAsync(facts, currentDocument!, state).ConfigureAwait(false);
                await WriteResponseAsync(context.Response, response).ConfigureAwait(false);
            }
            catch
            {
                state.TryFail();
                await TryWriteFailureAsync(context.Response, FailureCode.InternalFailure).ConfigureAwait(false);
            }
            finally
            {
                if (gateHeld)
                {
                    if (state.State != CertifiedRequestState.Completed && state.State != CertifiedRequestState.Failed)
                        state.TryFail();
                    state.TryAdvance(CertifiedRequestState.Released);
                    _singleFlight.Exit();
                }
                try
                {
                    context.Response.Close();
                }
                catch
                {
                }
            }
        }

        private async Task<ResponsePayload> ExecuteCertifiedRequestAsync(
            CertifiedRequestFacts facts,
            DocumentBinding currentDocument,
            CertifiedRequestStateMachine state)
        {
            CertifiedExternalWorkItem capture = CertifiedExternalWorkItem.Capture(currentDocument);
            if (!_workSlot.TryQueue(capture))
            {
                state.TryFail();
                return ResponsePayload.Failure(FailureCode.Busy);
            }
            if (_externalEvent.Raise() != ExternalEventRequest.Accepted)
            {
                _workSlot.FailPending(FailureCode.RevitUnavailable);
                state.TryFail();
                return ResponsePayload.Failure(FailureCode.RevitUnavailable);
            }
            state.TryAdvance(CertifiedRequestState.CaptureQueued);
            CertifiedExternalWorkResult captured = await capture.Completion.Task.ConfigureAwait(false);
            if (!captured.Succeeded || captured.Binding == null)
            {
                state.TryFail();
                return ResponsePayload.Failure(captured.FailureCode);
            }
            state.TryAdvance(CertifiedRequestState.BindingCaptured);

            if (_runtimeAttestation == null || !ProtocolValidation.IsSha256(_runtimeAttestationSha256))
            {
                state.TryFail();
                return ResponsePayload.Failure(FailureCode.AuthorizationUnavailable);
            }
            AuthorizationImmutableFields authorizationFields = new AuthorizationImmutableFields(
                SafeReadContract.RouteId,
                _identity.HostInstanceId,
                SafeReadContract.ExecutorId,
                _runtimeAttestationSha256!,
                _runtimeAttestation,
                new AuthorizationDocument(captured.Binding.ProjectFingerprint, captured.Binding.DocumentSessionId),
                facts.ClientSessionId,
                facts.RequestId,
                facts.AttemptId,
                ProtocolValidation.Sha256Digest(facts.CapabilityNonce));
            AuthorizationDecision authorization = await _authorizationGate.AuthorizeAsync(
                authorizationFields,
                facts.CapabilityNonce,
                _shutdown.Token).ConfigureAwait(false);
            if (!authorization.Authorized || authorization.Receipt == null)
            {
                state.TryFail();
                return ResponsePayload.Failure(FailureCode.AuthorizationUnavailable);
            }
            state.TryAdvance(CertifiedRequestState.AuthorizationVerified);

            DocumentBinding? beforeCount = _documentTracker.Current;
            if (beforeCount == null ||
                !object.ReferenceEquals(beforeCount.RuntimeIdentity, captured.Binding.RuntimeIdentity) ||
                !string.Equals(beforeCount.ProjectFingerprint, captured.Binding.ProjectFingerprint, StringComparison.Ordinal) ||
                !string.Equals(beforeCount.DocumentSessionId, captured.Binding.DocumentSessionId, StringComparison.Ordinal) ||
                beforeCount.IsModified != captured.Binding.IsModified)
            {
                state.TryFail();
                return ResponsePayload.Failure(FailureCode.DocumentChanged);
            }

            CertifiedExternalWorkItem count = CertifiedExternalWorkItem.Count(
                captured.Binding,
                authorization.AuthorizationExpiresAtUtc);
            if (!_workSlot.TryQueue(count))
            {
                state.TryFail();
                return ResponsePayload.Failure(FailureCode.Busy);
            }
            if (_externalEvent.Raise() != ExternalEventRequest.Accepted)
            {
                _workSlot.FailPending(FailureCode.RevitUnavailable);
                state.TryFail();
                return ResponsePayload.Failure(FailureCode.RevitUnavailable);
            }
            state.TryAdvance(CertifiedRequestState.CountQueued);
            CertifiedExternalWorkResult counted = await count.Completion.Task.ConfigureAwait(false);
            if (!counted.Succeeded)
            {
                state.TryFail();
                return ResponsePayload.Failure(counted.FailureCode);
            }
            state.TryAdvance(CertifiedRequestState.Completed);
            return ResponsePayload.Success(counted.Count);
        }

        private static async Task WriteResponseAsync(HttpListenerResponse response, ResponsePayload payload)
        {
            response.StatusCode = payload.StatusCode;
            response.ContentType = SafeReadContract.ResponseContentType;
            response.SendChunked = false;
            response.KeepAlive = false;
            response.ContentLength64 = payload.Body.Length;
            response.Headers["Cache-Control"] = "no-store";
            await response.OutputStream.WriteAsync(payload.Body, 0, payload.Body.Length).ConfigureAwait(false);
        }

        private static async Task TryWriteFailureAsync(HttpListenerResponse response, FailureCode failureCode)
        {
            try
            {
                await WriteResponseAsync(response, ResponsePayload.Failure(failureCode)).ConfigureAwait(false);
            }
            catch
            {
            }
        }
    }
}
