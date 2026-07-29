using System;
using System.IO;
using System.Net.Http;
using System.Security.AccessControl;
using System.Security.Principal;
using RevitOperator.SafeReadHost.HostKernel;
using Xunit;

namespace RevitOperator.SafeReadHost.Tests
{
    public sealed class AuthorizationTransportBootstrapTests
    {
        [Fact]
        public void Hosted_and_production_load_only_the_fixed_proxy_contract()
        {
            foreach (string mode in new[] { "hosted", "production" })
            {
                string? loadedFrom = null;
                bool loaded = AuthorizationTransportBootstrap.TryLoad(
                    mode, null, null, null, null, "C:\\Users\\operator\\AppData\\Local",
                    root => { loadedFrom = ProxyAuthorizationSecretStore.PathFor(root); return Secret(); },
                    out FixedBackendOrigin? origin, out BackendCredentials? credentials);
                Assert.True(loaded);
                Assert.Equal(new Uri(SafeReadContract.ProxyAuthorizationOrigin), origin!.Value);
                Assert.EndsWith("RevitOperator\\SafeRead\\proxy\\authorization_secret.v1.bin", loadedFrom, StringComparison.Ordinal);
                BackendCredentials safeCredentials = Assert.IsType<BackendCredentials>(credentials);
                using (safeCredentials)
                using (HttpRequestMessage request = new HttpRequestMessage(HttpMethod.Post, SafeReadContract.PreauthorizationPath))
                {
                    safeCredentials.Apply(request);
                    Assert.True(request.Headers.TryGetValues(SafeReadContract.ProxyAuthorizationHeader, out var values));
                    Assert.Equal("AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE", Assert.Single(values));
                    Assert.Null(request.Headers.Authorization);
                    Assert.False(request.Headers.Contains("x-operator-token"));
                }
            }
        }

        [Fact]
        public void Hosted_never_falls_back_to_direct_origin_or_credentials()
        {
            int loads = 0;
            Func<string, byte[]> loader = _ => { loads++; return Secret(); };
            Assert.False(Load("hosted", "https://operator.example", null, null, null, loader));
            Assert.False(Load("hosted", null, "hosted-bearer", null, null, loader));
            Assert.False(Load("production", null, null, "hosted-token", null, loader));
            Assert.Equal(0, loads);
        }

        [Theory]
        [InlineData("http://localhost:3907")]
        [InlineData("http://127.0.0.1:3908")]
        [InlineData("https://127.0.0.1:3907")]
        [InlineData(" http://127.0.0.1:3907")]
        [InlineData("http://127.0.0.1:3907/")]
        public void Proxy_origin_override_must_be_exact(string configured)
        {
            Assert.False(Load("hosted", null, null, null, configured, _ => Secret()));
        }

        [Theory]
        [InlineData("Hosted")]
        [InlineData(" hosted")]
        [InlineData("hosted ")]
        [InlineData("certified")]
        public void Ambiguous_runtime_modes_fail_closed(string mode)
        {
            Assert.False(Load(mode, null, null, null, null, _ => Secret()));
        }

        [Fact]
        public void Direct_transport_remains_bounded_to_local_self_hosted_and_development()
        {
            foreach (string? mode in new string?[] { null, "local", "self_hosted", "development" })
            {
                Assert.True(AuthorizationTransportBootstrap.TryLoad(
                    mode, "https://operator.example", null, "local-token", null, "unused", _ => throw new Exception("proxy loader must not run"),
                    out FixedBackendOrigin? origin, out BackendCredentials? credentials));
                Assert.Equal(new Uri("https://operator.example"), origin!.Value);
                credentials!.Dispose();
            }
            Assert.False(Load("local", "https://operator.example", null, "local-token", SafeReadContract.ProxyAuthorizationOrigin, _ => Secret()));
        }

        [Fact]
        public void Missing_or_malformed_proxy_secret_fails_closed()
        {
            Assert.False(Load("hosted", null, null, null, null, _ => throw new FileNotFoundException()));
            Assert.False(Load("hosted", null, null, null, null, _ => new byte[31]));
            Assert.False(Load("hosted", null, null, null, null, _ => new byte[33]));
            Assert.Throws<InvalidOperationException>(() => ProxyAuthorizationSecretStore.ValidateFileFacts(false, default(FileAttributes), 0));
            Assert.Throws<InvalidOperationException>(() => ProxyAuthorizationSecretStore.ValidateFileFacts(true, FileAttributes.ReparsePoint, 32));
            Assert.Throws<InvalidOperationException>(() => ProxyAuthorizationSecretStore.ValidateFileFacts(true, FileAttributes.Normal, 31));
            ProxyAuthorizationSecretStore.ValidateFileFacts(true, FileAttributes.Normal, 32);
        }

        [Fact]
        public void Credential_diagnostics_are_redacted()
        {
            byte[] secret = Secret();
            string encoded = "AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE";
            using BackendCredentials credentials = BackendCredentials.CreateProxy(secret)!;
            Assert.DoesNotContain(encoded, credentials.ToString(), StringComparison.Ordinal);
            Assert.Equal("BackendCredentials(redacted)", credentials.ToString());
        }

        [Fact]
        public void Secret_path_is_fixed_beneath_local_application_data()
        {
            string path = ProxyAuthorizationSecretStore.PathFor("C:\\Users\\operator\\AppData\\Local");
            Assert.Equal("C:\\Users\\operator\\AppData\\Local\\RevitOperator\\SafeRead\\proxy\\authorization_secret.v1.bin", path);
            Assert.Throws<InvalidOperationException>(() => ProxyAuthorizationSecretStore.PathFor(" C:\\unsafe"));
        }

        [Fact]
        public void Protected_secret_file_is_restart_stable_and_broad_acl_fails_closed()
        {
            string root = Path.Combine(AppContext.BaseDirectory, "proxy-secret-fixture-root");
            string path = ProxyAuthorizationSecretStore.PathFor(root);
            string directory = Assert.IsType<string>(Path.GetDirectoryName(path));
            SecureLocalStorage.EnsurePrivateDirectory(root, directory);
            File.WriteAllBytes(path, Secret());
            SecureLocalStorage.SecurePublishedFile(root, path);

            Assert.Equal(Secret(), ProxyAuthorizationSecretStore.Load(root));
            Assert.Equal(Secret(), ProxyAuthorizationSecretStore.Load(root));

            FileInfo file = new FileInfo(path);
            FileSecurity security = file.GetAccessControl(AccessControlSections.Owner | AccessControlSections.Access);
            SecurityIdentifier everyone = new SecurityIdentifier(WellKnownSidType.WorldSid, null);
            security.AddAccessRule(new FileSystemAccessRule(everyone, FileSystemRights.ReadData, AccessControlType.Allow));
            file.SetAccessControl(security);
            try { Assert.Throws<UnauthorizedAccessException>(() => ProxyAuthorizationSecretStore.Load(root)); }
            finally { SecureLocalStorage.SecurePublishedFile(root, path); }
        }

        private static bool Load(string? mode, string? origin, string? bearer, string? token, string? proxyOrigin, Func<string, byte[]> loader)
        {
            bool result = AuthorizationTransportBootstrap.TryLoad(mode, origin, bearer, token, proxyOrigin, "C:\\Users\\operator\\AppData\\Local", loader, out _, out BackendCredentials? credentials);
            credentials?.Dispose();
            return result;
        }

        private static byte[] Secret()
        {
            byte[] value = new byte[32];
            for (int i = 0; i < value.Length; i++) value[i] = 1;
            return value;
        }
    }
}
