using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Net;
using System.Net.Sockets;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using Autodesk.Revit.DB;
using Autodesk.Revit.UI;
using RevitOperator.SafeReadCertifiedExecution;
using RevitOperator.SafeReadHost.HostKernel;
using Xunit;

namespace RevitOperator.SafeReadHost.Tests
{
    public sealed class ProductionRuntimeSafetyTests
    {
        [Fact]
        public async Task Proven_preconnect_failure_is_known_and_retryable()
        {
            int port = ReserveClosedPort();
            using SafeReadBackendAuthorizer authorizer = Authorizer(port);
            BackendAuthorizationResult result = await authorizer.AuthorizeAsync(Bindings(), new byte[32], CancellationToken.None);
            Assert.NotNull(result.Failure);
            Assert.True(result.Failure!.Retryable);
            Assert.False(result.Failure.RequestDispatched);
            Assert.False(result.Failure.OutcomeUnknown);
            Assert.Contains("preconnect", result.Failure.Stage, StringComparison.Ordinal);
        }

        [Fact]
        public async Task Preauthorization_body_read_then_reset_is_dispatched_unknown_and_not_retryable()
        {
            using LoopbackBackend server = new LoopbackBackend(new[] { Reply.ResetAfterBody() });
            using SafeReadBackendAuthorizer authorizer = Authorizer(server.Port);
            BackendAuthorizationResult result = await authorizer.AuthorizeAsync(Bindings(), new byte[32], CancellationToken.None);
            AssertUnknown(result, "preauthorization_dispatch");
            await server.Completion;
            Assert.True(server.RequestBodies[0].Contains(SafeReadContract.PreauthorizationSchema, StringComparison.Ordinal));
        }

        [Fact]
        public async Task Final_authorization_body_read_then_outer_deadline_is_dispatched_unknown()
        {
            using LoopbackBackend server = new LoopbackBackend(new[] { Reply.Json(PreauthorizationJson()), Reply.DelayAfterBody() });
            using SafeReadBackendAuthorizer authorizer = Authorizer(server.Port);
            using CancellationTokenSource outerDeadline = new CancellationTokenSource(TimeSpan.FromMilliseconds(350));
            BackendAuthorizationResult result = await new BackendAuthorizationCoordinator(TimeSpan.FromSeconds(2)).AuthorizeAsync(authorizer, Bindings(), new byte[32], outerDeadline.Token);
            AssertUnknown(result, "final_authorization_dispatch");
            Assert.Equal(2, server.RequestBodies.Count);
            Assert.Contains(SafeReadContract.FinalAuthorizationSchema, server.RequestBodies[1], StringComparison.Ordinal);
        }

        [Fact]
        public async Task Final_authorization_body_read_then_auth_deadline_is_dispatched_unknown()
        {
            using LoopbackBackend server = new LoopbackBackend(new[] { Reply.Json(PreauthorizationJson()), Reply.DelayAfterBody() });
            using SafeReadBackendAuthorizer authorizer = Authorizer(server.Port);
            using CancellationTokenSource outerDeadline = new CancellationTokenSource(TimeSpan.FromSeconds(2));
            BackendAuthorizationResult result = await new BackendAuthorizationCoordinator(TimeSpan.FromMilliseconds(350)).AuthorizeAsync(authorizer, Bindings(), new byte[32], outerDeadline.Token);
            AssertUnknown(result, "final_authorization_dispatch");
            Assert.Equal(2, server.RequestBodies.Count);
        }

        [Fact]
        public async Task Proxy_transport_preserves_exact_paths_body_header_and_post_dispatch_unknown_truth()
        {
            byte[] secret = new byte[32];
            for (int i = 0; i < secret.Length; i++) secret[i] = 1;
            using LoopbackBackend server = new LoopbackBackend(new[] { Reply.Json(PreauthorizationJson()), Reply.ResetAfterBody() });
            Assert.True(FixedBackendOrigin.TryCreate("http://127.0.0.1:" + server.Port.ToString(CultureInfo.InvariantCulture), out FixedBackendOrigin? origin));
            using SafeReadBackendAuthorizer authorizer = new SafeReadBackendAuthorizer(origin!, BackendCredentials.CreateProxy(secret)!, new FinalReceiptVerifier());
            BackendAuthorizationResult result = await authorizer.AuthorizeAsync(Bindings(), new byte[32], CancellationToken.None);
            AssertUnknown(result, "final_authorization_dispatch");
            await server.Completion;
            Assert.Equal(new[] { SafeReadContract.PreauthorizationPath, SafeReadContract.FinalAuthorizationPath }, server.RequestTargets);
            Assert.All(server.RequestHeaders, headers =>
            {
                Assert.Contains(SafeReadContract.ProxyAuthorizationHeader + ": AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE", headers, StringComparison.Ordinal);
                Assert.DoesNotContain("Authorization: Bearer", headers, StringComparison.OrdinalIgnoreCase);
                Assert.DoesNotContain("x-operator-token", headers, StringComparison.OrdinalIgnoreCase);
            });
            AuthorizationBindings bindings = Bindings();
            Assert.Equal(SafeReadBackendAuthorizer.CreatePreauthorizationJson(bindings, Protocol.Sha256(new byte[32])), server.RequestBodies[0]);
            Assert.Equal(SafeReadBackendAuthorizer.CreateFinalAuthorizationJson(bindings, "src1_" + new string('a', 43), Protocol.Base64Url(new byte[32])), server.RequestBodies[1]);
        }

        [Fact]
        public async Task Proxy_loss_before_dispatch_remains_known_and_retryable()
        {
            int port = ReserveClosedPort();
            Assert.True(FixedBackendOrigin.TryCreate("http://127.0.0.1:" + port.ToString(CultureInfo.InvariantCulture), out FixedBackendOrigin? origin));
            using SafeReadBackendAuthorizer authorizer = new SafeReadBackendAuthorizer(origin!, BackendCredentials.CreateProxy(new byte[32])!, new FinalReceiptVerifier());
            BackendAuthorizationResult result = await authorizer.AuthorizeAsync(Bindings(), new byte[32], CancellationToken.None);
            Assert.NotNull(result.Failure);
            Assert.True(result.Failure!.Retryable);
            Assert.False(result.Failure.RequestDispatched);
            Assert.False(result.Failure.OutcomeUnknown);
            Assert.Contains("preconnect", result.Failure.Stage, StringComparison.Ordinal);
        }

        [Fact]
        public async Task Structured_backend_failure_survives_production_transport()
        {
            string denial = "{\"ok\":false,\"code\":\"policy_denied\",\"error\":\"Policy denied this exact runtime.\",\"retryable\":false,\"request_dispatched\":true,\"outcome_unknown\":false}";
            using LoopbackBackend server = new LoopbackBackend(new[] { Reply.Json(denial, 403) });
            using SafeReadBackendAuthorizer authorizer = Authorizer(server.Port);
            BackendAuthorizationResult result = await authorizer.AuthorizeAsync(Bindings(), new byte[32], CancellationToken.None);
            Assert.NotNull(result.Failure);
            Assert.Equal("Policy denied this exact runtime.", result.Failure!.Error);
            Assert.False(result.Failure.Retryable);
            Assert.True(result.Failure.RequestDispatched);
            Assert.False(result.Failure.OutcomeUnknown);
            Assert.Equal("preauthorization_response", result.Failure.Stage);
        }

        [Theory]
        [InlineData("{\"ok\":true,\"ok\":true,\"authorization\":{}}")]
        [InlineData("{\"authorization\":{},\"ok\":true}")]
        [InlineData("{\"ok\":\"true\",\"authorization\":{}}")]
        [InlineData("{\"ok\":true,\"authorization\":{}} ")]
        [InlineData("{\"ok\":true,\"authorization\":{\"schema\":\"bad\\x\"}}")]
        [InlineData("{\"ok\":false,\"code\":true,\"error\":\"denied\",\"retryable\":false,\"request_dispatched\":false,\"outcome_unknown\":false}")]
        public async Task Complete_malformed_backend_json_is_known_invalid_not_transport_unknown(string body)
        {
            using LoopbackBackend server = new LoopbackBackend(new[] { Reply.Json(body) });
            using SafeReadBackendAuthorizer authorizer = Authorizer(server.Port);
            BackendAuthorizationResult result = await authorizer.AuthorizeAsync(Bindings(), new byte[32], CancellationToken.None);
            Assert.NotNull(result.Failure);
            Assert.False(result.Failure!.Retryable);
            Assert.True(result.Failure.RequestDispatched);
            Assert.False(result.Failure.OutcomeUnknown);
            Assert.Equal("preauthorization_response", result.Failure.Stage);
        }

        [Fact]
        public async Task Pending_raise_failure_is_known_but_claimed_raise_failure_is_unknown()
        {
            DocumentBinding binding = Binding();
            CertifiedExternalWorkSlot pendingSlot = new CertifiedExternalWorkSlot();
            CertifiedExecutionResult pending = await new CertifiedExternalEventDispatcher(pendingSlot, new FixedRaiser(false))
                .DispatchAsync(CertifiedExternalWorkItem.Capture(binding), CancellationToken.None);
            Assert.False(pending.RequestDispatched);
            Assert.False(pending.OutcomeUnknown);
            Assert.Equal(CertifiedFailureCode.RevitUnavailable, pending.FailureCode);

            CertifiedExternalWorkSlot claimedSlot = new CertifiedExternalWorkSlot();
            ClaimingRaiser claiming = new ClaimingRaiser(claimedSlot, false);
            CertifiedExecutionResult claimed = await new CertifiedExternalEventDispatcher(claimedSlot, claiming)
                .DispatchAsync(CertifiedExternalWorkItem.Capture(binding), CancellationToken.None);
            Assert.True(claimed.RequestDispatched);
            Assert.True(claimed.OutcomeUnknown);
            claimedSlot.FailPending(CertifiedFailureCode.RevitUnavailable);
        }

        [Fact]
        public async Task Event_deadline_distinguishes_pending_cancel_from_claimed_execution()
        {
            DocumentBinding binding = Binding();
            using CancellationTokenSource firstDeadline = new CancellationTokenSource(TimeSpan.FromMilliseconds(40));
            CertifiedExternalWorkSlot pendingSlot = new CertifiedExternalWorkSlot();
            CertifiedExecutionResult pending = await new CertifiedExternalEventDispatcher(pendingSlot, new FixedRaiser(true))
                .DispatchAsync(CertifiedExternalWorkItem.Capture(binding), firstDeadline.Token);
            Assert.False(pending.RequestDispatched);
            Assert.False(pending.OutcomeUnknown);

            using CancellationTokenSource secondDeadline = new CancellationTokenSource(TimeSpan.FromMilliseconds(40));
            CertifiedExternalWorkSlot claimedSlot = new CertifiedExternalWorkSlot();
            CertifiedExecutionResult claimed = await new CertifiedExternalEventDispatcher(claimedSlot, new ClaimingRaiser(claimedSlot, true))
                .DispatchAsync(CertifiedExternalWorkItem.Capture(binding), secondDeadline.Token);
            Assert.True(claimed.RequestDispatched);
            Assert.True(claimed.OutcomeUnknown);
            claimedSlot.FailPending(CertifiedFailureCode.RevitUnavailable);
        }

        [Fact]
        public async Task Shutdown_is_known_before_claim_and_unknown_after_claim()
        {
            DocumentBinding binding = Binding();
            CertifiedExternalWorkSlot pendingSlot = new CertifiedExternalWorkSlot();
            CertifiedExternalWorkItem pendingItem = CertifiedExternalWorkItem.Capture(binding);
            Assert.True(pendingSlot.TryQueue(pendingItem));
            pendingSlot.FailPending(CertifiedFailureCode.RevitUnavailable);
            CertifiedExecutionResult pending = await pendingItem.Completion;
            Assert.False(pending.RequestDispatched);
            Assert.False(pending.OutcomeUnknown);

            CertifiedExternalWorkSlot claimedSlot = new CertifiedExternalWorkSlot();
            CertifiedExternalWorkItem claimedItem = CertifiedExternalWorkItem.Capture(binding);
            Assert.True(claimedSlot.TryQueue(claimedItem));
            Assert.Same(claimedItem, claimedSlot.Take());
            claimedSlot.FailPending(CertifiedFailureCode.RevitUnavailable);
            CertifiedExecutionResult claimed = await claimedItem.Completion;
            Assert.True(claimed.RequestDispatched);
            Assert.True(claimed.OutcomeUnknown);
        }

        [Fact]
        public void Dirty_to_dirty_document_change_rotates_monotonic_revision_and_session()
        {
            object document = new object();
            DocumentSessionTracker tracker = new DocumentSessionTracker();
            DocumentIdentityFacts dirty = Facts(document, true);
            DocumentBinding before = tracker.Observe(dirty)!;
            DocumentBinding after = tracker.MarkChanged(dirty)!;
            Assert.True(after.Revision > before.Revision);
            Assert.NotEqual(after.DocumentSessionId, before.DocumentSessionId);
            Assert.Equal(CertifiedFailureCode.DocumentChanged, DocumentBindingVerifier.Verify(before, dirty, tracker.Current));
        }

        [Fact]
        public void Save_save_as_switch_and_close_rotate_or_clear_revision_binding()
        {
            object first = new object(), second = new object();
            DocumentSessionTracker tracker = new DocumentSessionTracker();
            DocumentBinding opened = tracker.Observe(Facts(first, true))!;
            DocumentBinding saving = tracker.MarkTransition(Facts(first, true))!;
            DocumentBinding saved = tracker.MarkTransition(Facts(first, false))!;
            DocumentBinding savedAs = tracker.MarkTransition(new DocumentIdentityFacts(first, "sha256:" + new string('d', 64), true, false, false))!;
            DocumentBinding switched = tracker.Observe(Facts(second, false))!;
            Assert.True(opened.Revision < saving.Revision && saving.Revision < saved.Revision && saved.Revision < savedAs.Revision && savedAs.Revision < switched.Revision);
            tracker.ClearIfCurrent(second);
            Assert.Null(tracker.Current);
            DocumentBinding reopened = tracker.Observe(Facts(first, false))!;
            Assert.True(reopened.Revision > switched.Revision);
        }

        [Fact]
        public async Task Production_external_handler_rechecks_revision_immediately_before_executor()
        {
            Document document = new Document { Title = "A", PathName = "C:\\A.rvt", IsModified = true, IsModifiable = false };
            DocumentSessionTracker tracker = new DocumentSessionTracker();
            DocumentBinding captured = RevitDocumentAccess.Observe(document, tracker)!;
            CertifiedExternalWorkSlot slot = new CertifiedExternalWorkSlot();
            VerifiedFinalAuthorizationToken token = new VerifiedFinalAuthorizationToken(Bindings(captured), "srr1_" + new string('a', 43), DateTimeOffset.UtcNow.AddMinutes(1));
            CertifiedExternalWorkItem item = CertifiedExternalWorkItem.Count(captured, token);
            Assert.True(slot.TryQueue(item));
            tracker.MarkChanged(RevitDocumentAccess.CreateFacts(document));
            CertifiedSheetCountKernel.ExecuteOverride = _ => throw new InvalidOperationException("executor must not run after revision drift");
            try
            {
                new CertifiedSheetsCountExternalEventHandler(slot, tracker).Execute(new UIApplication { ActiveUIDocument = new UIDocument { Document = document } });
                CertifiedExecutionResult result = await item.Completion;
                Assert.Equal(CertifiedFailureCode.DocumentChanged, result.FailureCode);
            }
            finally { CertifiedSheetCountKernel.ExecuteOverride = null; }
        }

        [Fact]
        public void Broad_acl_and_reparse_points_are_rejected_by_production_policy()
        {
            SecurityIdentifier owner = new SecurityIdentifier(WellKnownSidType.BuiltinUsersSid, null);
            SecurityIdentifier everyone = new SecurityIdentifier(WellKnownSidType.WorldSid, null);
            Assert.True(SecureLocalStorage.IsAllowedPrincipal(owner, owner));
            Assert.True(SecureLocalStorage.IsAllowedPrincipal(new SecurityIdentifier(WellKnownSidType.LocalSystemSid, null), owner));
            Assert.True(SecureLocalStorage.IsAllowedPrincipal(new SecurityIdentifier(WellKnownSidType.BuiltinAdministratorsSid, null), owner));
            Assert.False(SecureLocalStorage.IsAllowedPrincipal(everyone, owner));
            Assert.Throws<UnauthorizedAccessException>(() => SecureLocalStorage.ValidateRule(everyone, AccessControlType.Allow, false, owner));
            Assert.Throws<UnauthorizedAccessException>(() => SecureLocalStorage.ValidateRule(owner, AccessControlType.Allow, true, owner));
            SecureLocalStorage.ValidateRule(owner, AccessControlType.Allow, false, owner);
            Assert.Throws<UnauthorizedAccessException>(() => SecureLocalStorage.RejectReparse(true, FileAttributes.ReparsePoint));
            SecureLocalStorage.RejectReparse(false, FileAttributes.ReparsePoint);
        }

        [Fact]
        public void Production_attestation_parser_accepts_only_exact_active_manifest()
        {
            DateTimeOffset now = new DateTimeOffset(2026, 7, 29, 12, 0, 0, TimeSpan.Zero);
            string manifest = AttestationJson(now.AddMinutes(-1), now.AddMinutes(10));
            RuntimeTuple tuple = RuntimeDeploymentAttestation.Parse(manifest, 2025, now);
            Assert.Equal("2025.1", tuple.RevitVersion);
            Assert.Throws<InvalidOperationException>(() => RuntimeDeploymentAttestation.Parse(AttestationJson(now.AddMinutes(-20), now.AddMinutes(-1)), 2025, now));
            Assert.Throws<InvalidOperationException>(() => RuntimeDeploymentAttestation.Parse(manifest.Replace("\"state\":\"active\"", "\"state\":\"revoked\"", StringComparison.Ordinal), 2025, now));
            Assert.Throws<InvalidOperationException>(() => RuntimeDeploymentAttestation.Parse(manifest.Replace("\"runtime_tuple\":", "\"extra\":true,\"runtime_tuple\":", StringComparison.Ordinal), 2025, now));
            Assert.Throws<InvalidOperationException>(() => RuntimeDeploymentAttestation.Parse(manifest.Replace("\"state\":\"active\"", "\"state\":\"active\",\"state\":\"active\"", StringComparison.Ordinal), 2025, now));
            Assert.Throws<InvalidOperationException>(() => RuntimeDeploymentAttestation.Parse(manifest.Replace("\"schema\":\"" + SafeReadContract.RuntimeAttestationSchema + "\",\"state\":\"active\"", "\"state\":\"active\",\"schema\":\"" + SafeReadContract.RuntimeAttestationSchema + "\"", StringComparison.Ordinal), 2025, now));
            Assert.Throws<InvalidOperationException>(() => RuntimeDeploymentAttestation.Parse(manifest.Replace("\"state\":\"active\"", "\"state\":true", StringComparison.Ordinal), 2025, now));
        }

        [Fact]
        public void Production_discovery_publisher_uses_injected_atomic_store_and_removes_only_owned_record()
        {
            InstanceIdentity identity = InstanceIdentity.Create();
            RuntimeTuple tuple = new RuntimeTuple("sha256:" + new string('b', 64), "22222222-2222-2222-2222-222222222222", "sha256:" + new string('c', 64), "33333333-3333-3333-3333-333333333333", "2025.1");
            RuntimeDeploymentAttestation attestation = new RuntimeDeploymentAttestation(tuple, "{}", "sha256:" + new string('a', 64));
            MemorySecureDiscoveryStore store = new MemorySecureDiscoveryStore();
            DiscoveryPublisher publisher = new DiscoveryPublisher(identity, 2025, "http://127.0.0.1:5040/", attestation, store);
            publisher.Publish(Binding());
            Assert.Single(store.Records);
            Assert.Contains(SafeReadContract.DiscoverySchema, store.Records[identity.HostInstanceId], StringComparison.Ordinal);
            Assert.Contains(identity.StartupToken, store.Records[identity.HostInstanceId], StringComparison.Ordinal);
            publisher.Remove();
            Assert.Empty(store.Records);
        }

        [Fact]
        public void Test_project_compiles_the_entire_production_host_surface_and_certified_project_has_evaluated_ratchet()
        {
            string project = File.ReadAllText(Path.Combine(Root(), "tests", "RevitOperator.SafeReadHost.Tests", "RevitOperator.SafeReadHost.Tests.csproj"));
            Assert.Contains("HostKernel\\**\\*.cs", project, StringComparison.Ordinal);
            Assert.Contains("HostApplication.cs", project, StringComparison.Ordinal);
            Assert.Contains("CertifiedSafeReadHttpHost.cs", project, StringComparison.Ordinal);
            string certified = File.ReadAllText(Path.Combine(Root(), "src", "RevitOperator.SafeReadCertifiedExecution", "RevitOperator.SafeReadCertifiedExecution.csproj"));
            Assert.Contains("@(Compile->Count())", certified, StringComparison.Ordinal);
            Assert.Contains("'@(Compile)'!='RevitCertifiedExecution.cs'", certified, StringComparison.Ordinal);
        }

        private static void AssertUnknown(BackendAuthorizationResult result, string stage)
        {
            Assert.NotNull(result.Failure);
            Assert.False(result.Failure!.Retryable);
            Assert.True(result.Failure.RequestDispatched);
            Assert.True(result.Failure.OutcomeUnknown);
            Assert.Equal(stage, result.Failure.Stage);
        }

        private static SafeReadBackendAuthorizer Authorizer(int port)
        {
            Assert.True(FixedBackendOrigin.TryCreate("http://127.0.0.1:" + port.ToString(CultureInfo.InvariantCulture), out FixedBackendOrigin? origin));
            return new SafeReadBackendAuthorizer(origin!, BackendCredentials.Create(null, "test-token")!, new FinalReceiptVerifier());
        }

        private static AuthorizationBindings Bindings(DocumentBinding? document = null)
        {
            document ??= Binding();
            return new AuthorizationBindings(SafeReadContract.RouteId, "11111111-1111-1111-1111-111111111111", SafeReadContract.ExecutorId, "sha256:" + new string('a', 64), new RuntimeTuple("sha256:" + new string('b', 64), "22222222-2222-2222-2222-222222222222", "sha256:" + new string('c', 64), "33333333-3333-3333-3333-333333333333", "2025.1"), document.ProjectFingerprint, document.DocumentSessionId, "44444444-4444-4444-4444-444444444444", "55555555-5555-5555-5555-555555555555", "66666666-6666-6666-6666-666666666666");
        }

        private static DocumentBinding Binding() => new DocumentBinding(new object(), "sha256:" + new string('f', 64), "77777777-7777-7777-7777-777777777777", false, 1);
        private static DocumentIdentityFacts Facts(object runtime, bool modified) => new DocumentIdentityFacts(runtime, "sha256:" + new string('f', 64), true, false, modified);

        private static string PreauthorizationJson()
        {
            DateTimeOffset now = DateTimeOffset.UtcNow;
            string issued = now.AddSeconds(-1).UtcDateTime.ToString("yyyy-MM-dd'T'HH:mm:ss.fff'Z'", CultureInfo.InvariantCulture);
            string expires = now.AddSeconds(20).UtcDateTime.ToString("yyyy-MM-dd'T'HH:mm:ss.fff'Z'", CultureInfo.InvariantCulture);
            return "{\"ok\":true,\"authorization\":{\"schema\":\"" + SafeReadContract.PreauthorizationResponseSchema + "\",\"capability_id\":\"src1_" + new string('a', 43) + "\",\"bindings_hash\":\"sha256:" + new string('d', 64) + "\",\"issued_at_utc\":\"" + issued + "\",\"expires_at_utc\":\"" + expires + "\"}}";
        }

        private static string AttestationJson(DateTimeOffset issued, DateTimeOffset expires)
        {
            string i = issued.UtcDateTime.ToString("yyyy-MM-dd'T'HH:mm:ss.fff'Z'", CultureInfo.InvariantCulture);
            string e = expires.UtcDateTime.ToString("yyyy-MM-dd'T'HH:mm:ss.fff'Z'", CultureInfo.InvariantCulture);
            return "{\"schema\":\"" + SafeReadContract.RuntimeAttestationSchema + "\",\"state\":\"active\",\"issued_at_utc\":\"" + i + "\",\"expires_at_utc\":\"" + e + "\",\"route_id\":\"" + SafeReadContract.RouteId + "\",\"route_contract_sha256\":\"sha256:cc80c231ba289396516164cb0fdbc3c71779ac018e717085f07a544530e68874\",\"policy_sha256\":\"sha256:23692b21a7e728e9c1ce5eec9580dcec4f3ac7f25d3d95059899c680a17aad67\",\"proof_sha256\":\"sha256:" + new string('d', 64) + "\",\"executor_id\":\"" + SafeReadContract.ExecutorId + "\",\"runtime_tuple\":{\"host_content_sha256\":\"sha256:" + new string('b', 64) + "\",\"host_mvid\":\"22222222-2222-2222-2222-222222222222\",\"revit_api_content_sha256\":\"sha256:" + new string('c', 64) + "\",\"revit_api_mvid\":\"33333333-3333-3333-3333-333333333333\",\"revit_version\":\"2025.1\"}}";
        }

        private static int ReserveClosedPort()
        {
            TcpListener listener = new TcpListener(IPAddress.Loopback, 0);
            listener.Start();
            int port = ((IPEndPoint)listener.LocalEndpoint).Port;
            listener.Stop();
            return port;
        }

        private static string Root()
        {
            DirectoryInfo? cursor = new DirectoryInfo(AppContext.BaseDirectory);
            while (cursor != null) { if (File.Exists(Path.Combine(cursor.FullName, "RevitSafeReadHost.sln"))) return cursor.FullName; cursor = cursor.Parent; }
            throw new DirectoryNotFoundException();
        }

        private sealed class FixedRaiser : ICertifiedExternalEventRaiser
        {
            private readonly bool _result;
            public FixedRaiser(bool result) { _result = result; }
            public bool TryRaise() => _result;
        }

        private sealed class MemorySecureDiscoveryStore : ISecureDiscoveryStore
        {
            public Dictionary<string, string> Records { get; } = new Dictionary<string, string>(StringComparer.Ordinal);
            public void Publish(string hostInstanceId, string content) => Records[hostInstanceId] = content;
            public void Remove(string hostInstanceId) => Records.Remove(hostInstanceId);
        }

        private sealed class ClaimingRaiser : ICertifiedExternalEventRaiser
        {
            private readonly CertifiedExternalWorkSlot _slot; private readonly bool _result;
            public ClaimingRaiser(CertifiedExternalWorkSlot slot, bool result) { _slot = slot; _result = result; }
            public bool TryRaise() { _slot.Take(); return _result; }
        }

        private sealed class Reply
        {
            private Reply(string? body, int status, bool reset, bool delay) { Body = body; Status = status; Reset = reset; Delay = delay; }
            public string? Body { get; } public int Status { get; } public bool Reset { get; } public bool Delay { get; }
            public static Reply Json(string body, int status = 200) => new Reply(body, status, false, false);
            public static Reply ResetAfterBody() => new Reply(null, 0, true, false);
            public static Reply DelayAfterBody() => new Reply(null, 0, false, true);
        }

        private sealed class LoopbackBackend : IDisposable
        {
            private readonly TcpListener _listener;
            private readonly CancellationTokenSource _stop = new CancellationTokenSource();
            public LoopbackBackend(IEnumerable<Reply> replies)
            {
                _listener = new TcpListener(IPAddress.Loopback, 0);
                _listener.Start();
                Port = ((IPEndPoint)_listener.LocalEndpoint).Port;
                Completion = Serve(replies);
            }
            public int Port { get; }
            public List<string> RequestBodies { get; } = new List<string>();
            public List<string> RequestHeaders { get; } = new List<string>();
            public List<string> RequestTargets { get; } = new List<string>();
            public Task Completion { get; }

            private async Task Serve(IEnumerable<Reply> replies)
            {
                foreach (Reply reply in replies)
                {
                    using (TcpClient probe = await _listener.AcceptTcpClientAsync(_stop.Token)) { }
                    using TcpClient request = await _listener.AcceptTcpClientAsync(_stop.Token);
                    CapturedRequest captured = await ReadRequest(request.GetStream(), _stop.Token);
                    RequestBodies.Add(captured.Body);
                    RequestHeaders.Add(captured.Headers);
                    RequestTargets.Add(captured.Target);
                    if (reply.Reset)
                    {
                        request.Client.LingerState = new LingerOption(true, 0);
                        continue;
                    }
                    if (reply.Delay)
                    {
                        try { await Task.Delay(TimeSpan.FromSeconds(5), _stop.Token); } catch (OperationCanceledException) { }
                        continue;
                    }
                    byte[] bytes = Encoding.UTF8.GetBytes(reply.Body!);
                    string reason = reply.Status == 200 ? "OK" : "Forbidden";
                    byte[] header = Encoding.ASCII.GetBytes("HTTP/1.1 " + reply.Status.ToString(CultureInfo.InvariantCulture) + " " + reason + "\r\nContent-Type: application/json\r\nContent-Length: " + bytes.Length.ToString(CultureInfo.InvariantCulture) + "\r\nConnection: close\r\n\r\n");
                    NetworkStream stream = request.GetStream();
                    await stream.WriteAsync(header, _stop.Token);
                    await stream.WriteAsync(bytes, _stop.Token);
                }
            }

            private static async Task<CapturedRequest> ReadRequest(NetworkStream stream, CancellationToken cancellation)
            {
                List<byte> bytes = new List<byte>();
                byte[] one = new byte[1];
                int headerEnd = -1;
                while (headerEnd < 0)
                {
                    int read = await stream.ReadAsync(one, cancellation);
                    if (read == 0) throw new EndOfStreamException();
                    bytes.Add(one[0]);
                    int n = bytes.Count;
                    if (n >= 4 && bytes[n - 4] == 13 && bytes[n - 3] == 10 && bytes[n - 2] == 13 && bytes[n - 1] == 10) headerEnd = n;
                }
                string headers = Encoding.ASCII.GetString(bytes.ToArray());
                string requestLine = headers.Split(new[] { "\r\n" }, StringSplitOptions.None)[0];
                string[] requestParts = requestLine.Split(' ');
                if (requestParts.Length != 3) throw new InvalidDataException("Invalid test request line.");
                int contentLength = 0;
                foreach (string line in headers.Split(new[] { "\r\n" }, StringSplitOptions.RemoveEmptyEntries))
                    if (line.StartsWith("Content-Length:", StringComparison.OrdinalIgnoreCase)) contentLength = Int32.Parse(line.Substring(line.IndexOf(':') + 1).Trim(), CultureInfo.InvariantCulture);
                byte[] body = new byte[contentLength];
                int offset = 0;
                while (offset < body.Length)
                {
                    int read = await stream.ReadAsync(body.AsMemory(offset), cancellation);
                    if (read == 0) throw new EndOfStreamException();
                    offset += read;
                }
                return new CapturedRequest(requestParts[1], headers, Encoding.UTF8.GetString(body));
            }

            private sealed class CapturedRequest
            {
                public CapturedRequest(string target, string headers, string body) { Target = target; Headers = headers; Body = body; }
                public string Target { get; }
                public string Headers { get; }
                public string Body { get; }
            }

            public void Dispose()
            {
                _stop.Cancel();
                _listener.Stop();
                try { Completion.GetAwaiter().GetResult(); } catch (OperationCanceledException) { } catch (ObjectDisposedException) { } catch (SocketException) { }
                _stop.Dispose();
            }
        }
    }
}
