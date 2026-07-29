using System;
using System.Collections.Generic;
using System.IO;
using System.Text;
using RevitOperator.SafeReadHost.Kernel;
using Xunit;

namespace RevitOperator.SafeReadHost.Tests
{
    public sealed class IdentityDiscoveryTests
    {
        [Fact]
        public void Generated_startup_identities_are_distinct_and_canonical()
        {
            InstanceIdentity first = InstanceIdentity.Create();
            InstanceIdentity second = InstanceIdentity.Create();

            Assert.True(ProtocolValidation.IsCanonicalGuid(first.HostInstanceId));
            Assert.True(ProtocolValidation.IsCanonicalGuid(second.HostInstanceId));
            Assert.True(ProtocolValidation.IsBase64UrlSecret(first.StartupToken));
            Assert.True(ProtocolValidation.IsBase64UrlSecret(second.StartupToken));
            Assert.NotEqual(first.HostInstanceId, second.HostInstanceId);
            Assert.NotEqual(first.StartupToken, second.StartupToken);
            Assert.True(first.TokenMatches(first.StartupToken));
            Assert.False(first.TokenMatches(second.StartupToken));
        }

        [Fact]
        public void Discovery_record_contains_only_its_safe_read_identity_and_document_binding()
        {
            DiscoveryRecord record = new DiscoveryRecord(
                TestFacts.HostInstanceId,
                TestFacts.StartupToken,
                "http://127.0.0.1:5040/",
                TestFacts.Binding());

            string json = DiscoveryRecordFormatter.Format(record);

            Assert.Equal(
                "{\"schema\":\"revit-operator.safe-read.instance.v1\",\"product_id\":\"AAFAA2C0-43F1-42A0-A6B4-D9A0C5F5CE0E\",\"host_instance_id\":\"11111111-1111-1111-1111-111111111111\",\"startup_token\":\"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA\",\"url\":\"http://127.0.0.1:5040/\",\"document_session_id\":\"22222222-2222-2222-2222-222222222222\",\"project_fingerprint\":\"sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc\"}",
                json);
            Assert.DoesNotContain("operator_token", json, StringComparison.OrdinalIgnoreCase);
            Assert.DoesNotContain("bridge_url", json, StringComparison.OrdinalIgnoreCase);
        }

        [Fact]
        public void Discovery_publisher_replaces_one_instance_record_and_removes_only_its_record()
        {
            MemoryDiscoveryStore store = new MemoryDiscoveryStore();
            InstanceIdentity identity = TestFacts.Identity();
            DiscoveryPublisher publisher = new DiscoveryPublisher(store, identity, "http://127.0.0.1:5042/");

            publisher.Publish(null);
            Assert.Single(store.Records);
            Assert.Contains("\"document_session_id\":null", store.Records[TestFacts.HostInstanceId]);

            publisher.Publish(TestFacts.Binding());
            Assert.Single(store.Records);
            Assert.Contains(TestFacts.DocumentSessionId, store.Records[TestFacts.HostInstanceId]);

            publisher.Remove();
            Assert.Empty(store.Records);
            publisher.Remove();
            Assert.Empty(store.Records);
        }

        [Fact]
        public void Separate_instances_do_not_overwrite_each_other()
        {
            MemoryDiscoveryStore store = new MemoryDiscoveryStore();
            InstanceIdentity first = InstanceIdentity.Create();
            InstanceIdentity second = InstanceIdentity.Create();
            DiscoveryPublisher firstPublisher = new DiscoveryPublisher(store, first, "http://127.0.0.1:5040/");
            DiscoveryPublisher secondPublisher = new DiscoveryPublisher(store, second, "http://127.0.0.1:5041/");

            firstPublisher.Publish(null);
            secondPublisher.Publish(null);
            Assert.Equal(2, store.Records.Count);
            Assert.Contains(first.StartupToken, store.Records[first.HostInstanceId]);
            Assert.Contains(second.StartupToken, store.Records[second.HostInstanceId]);

            firstPublisher.Remove();
            Assert.Single(store.Records);
            Assert.True(store.Records.ContainsKey(second.HostInstanceId));
        }

        [Fact]
        public void Filesystem_store_atomically_replaces_and_removes_only_owned_instance_records()
        {
            string root = Path.Combine(
                Path.GetTempPath(),
                "RevitOperator.SafeReadHost.Tests",
                Guid.NewGuid().ToString("N"));
            LocalAppDataDiscoveryStore store = new LocalAppDataDiscoveryStore(root);
            string secondInstance = "99999999-9999-9999-9999-999999999999";
            string firstPath = Path.Combine(root, TestFacts.HostInstanceId + ".json");
            string secondPath = Path.Combine(root, secondInstance + ".json");

            store.Publish(TestFacts.HostInstanceId, "{\"generation\":1}");
            Assert.Equal("{\"generation\":1}", File.ReadAllText(firstPath, Encoding.UTF8));
            byte[] initialBytes = File.ReadAllBytes(firstPath);
            Assert.False(initialBytes.Length >= 3 && initialBytes[0] == 0xef && initialBytes[1] == 0xbb && initialBytes[2] == 0xbf);

            store.Publish(TestFacts.HostInstanceId, "{\"generation\":2}");
            store.Publish(secondInstance, "{\"generation\":1}");
            Assert.Equal("{\"generation\":2}", File.ReadAllText(firstPath, Encoding.UTF8));
            Assert.Empty(Directory.GetFiles(root, "*.tmp", SearchOption.TopDirectoryOnly));

            store.Remove(TestFacts.HostInstanceId);
            Assert.False(File.Exists(firstPath));
            Assert.True(File.Exists(secondPath));
            store.Remove(secondInstance);
            Assert.False(File.Exists(secondPath));
        }

        [Theory]
        [InlineData(null, true, 0)]
        [InlineData("", true, 0)]
        [InlineData("5040", true, 5040)]
        [InlineData("5050", true, 5050)]
        [InlineData("5039", false, 0)]
        [InlineData("5051", false, 0)]
        [InlineData(" 5040", false, 0)]
        [InlineData("+5040", false, 0)]
        [InlineData("05040", true, 5040)]
        public void Port_override_is_validated(string? raw, bool valid, int expectedPort)
        {
            bool hasOverride;
            int port;
            bool result = PortPolicy.TryReadOverride(raw, out hasOverride, out port);

            Assert.Equal(valid, result);
            if (expectedPort == 0)
                Assert.False(hasOverride);
            else
            {
                Assert.True(hasOverride);
                Assert.Equal(expectedPort, port);
            }
        }

        private sealed class MemoryDiscoveryStore : IAtomicDiscoveryStore
        {
            public Dictionary<string, string> Records { get; } = new Dictionary<string, string>(StringComparer.Ordinal);

            public void Publish(string hostInstanceId, string content)
            {
                Records[hostInstanceId] = content;
            }

            public void Remove(string hostInstanceId)
            {
                Records.Remove(hostInstanceId);
            }
        }
    }
}
