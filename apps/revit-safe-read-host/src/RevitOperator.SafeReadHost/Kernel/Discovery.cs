using System;
using System.IO;
using System.Text;

namespace RevitOperator.SafeReadHost.Kernel
{
    internal interface IAtomicDiscoveryStore
    {
        void Publish(string hostInstanceId, string content);
        void Remove(string hostInstanceId);
    }

    internal sealed class DiscoveryRecord
    {
        public DiscoveryRecord(
            string hostInstanceId,
            string startupToken,
            string url,
            DocumentBinding? document)
        {
            HostInstanceId = hostInstanceId;
            StartupToken = startupToken;
            Url = url;
            DocumentSessionId = document == null ? null : document.DocumentSessionId;
            ProjectFingerprint = document == null ? null : document.ProjectFingerprint;
        }

        public string HostInstanceId { get; private set; }
        public string StartupToken { get; private set; }
        public string Url { get; private set; }
        public string? DocumentSessionId { get; private set; }
        public string? ProjectFingerprint { get; private set; }
    }

    internal static class DiscoveryRecordFormatter
    {
        public static string Format(DiscoveryRecord record)
        {
            if (record == null)
                throw new ArgumentNullException(nameof(record));
            if (!ProtocolValidation.IsCanonicalGuid(record.HostInstanceId) ||
                !ProtocolValidation.IsBase64UrlSecret(record.StartupToken))
                throw new ArgumentException("Invalid discovery identity.", nameof(record));
            Uri? uri;
            if (!Uri.TryCreate(record.Url, UriKind.Absolute, out uri) || uri == null ||
                !string.Equals(uri.Scheme, Uri.UriSchemeHttp, StringComparison.Ordinal) ||
                !string.Equals(uri.Host, "127.0.0.1", StringComparison.Ordinal) ||
                !PortPolicy.IsAllowed(uri.Port) ||
                !string.Equals(uri.AbsolutePath, "/", StringComparison.Ordinal) ||
                uri.Query.Length != 0 || uri.Fragment.Length != 0)
                throw new ArgumentException("Invalid discovery URL.", nameof(record));
            if (record.DocumentSessionId != null && !ProtocolValidation.IsCanonicalGuid(record.DocumentSessionId))
                throw new ArgumentException("Invalid document session.", nameof(record));
            if (record.ProjectFingerprint != null && !ProtocolValidation.IsSha256(record.ProjectFingerprint))
                throw new ArgumentException("Invalid project fingerprint.", nameof(record));

            string documentSession = record.DocumentSessionId == null ? "null" : Quote(record.DocumentSessionId);
            string projectFingerprint = record.ProjectFingerprint == null ? "null" : Quote(record.ProjectFingerprint);
            return "{\"schema\":" + Quote(SafeReadContract.DiscoverySchema) +
                   ",\"product_id\":" + Quote(SafeReadContract.ProductId) +
                   ",\"host_instance_id\":" + Quote(record.HostInstanceId) +
                   ",\"startup_token\":" + Quote(record.StartupToken) +
                   ",\"url\":" + Quote(record.Url) +
                   ",\"document_session_id\":" + documentSession +
                   ",\"project_fingerprint\":" + projectFingerprint + "}";
        }

        private static string Quote(string value)
        {
            StringBuilder builder = new StringBuilder(value.Length + 2);
            builder.Append('"');
            for (int index = 0; index < value.Length; index++)
            {
                char character = value[index];
                if (character == '"' || character == '\\')
                {
                    builder.Append('\\');
                    builder.Append(character);
                }
                else if (character < 0x20)
                {
                    builder.Append("\\u");
                    builder.Append(((int)character).ToString("x4"));
                }
                else
                {
                    builder.Append(character);
                }
            }
            builder.Append('"');
            return builder.ToString();
        }
    }

    internal sealed class DiscoveryPublisher
    {
        private readonly object _sync = new object();
        private readonly IAtomicDiscoveryStore _store;
        private readonly InstanceIdentity _identity;
        private readonly string _url;
        private bool _removed;

        public DiscoveryPublisher(IAtomicDiscoveryStore store, InstanceIdentity identity, string url)
        {
            _store = store ?? throw new ArgumentNullException(nameof(store));
            _identity = identity ?? throw new ArgumentNullException(nameof(identity));
            _url = url ?? throw new ArgumentNullException(nameof(url));
        }

        public void Publish(DocumentBinding? document)
        {
            lock (_sync)
            {
                if (_removed)
                    throw new InvalidOperationException("Discovery was already removed.");
                DiscoveryRecord record = new DiscoveryRecord(
                    _identity.HostInstanceId,
                    _identity.StartupToken,
                    _url,
                    document);
                _store.Publish(_identity.HostInstanceId, DiscoveryRecordFormatter.Format(record));
            }
        }

        public void Remove()
        {
            lock (_sync)
            {
                if (_removed)
                    return;
                _store.Remove(_identity.HostInstanceId);
                _removed = true;
            }
        }
    }

    internal sealed class LocalAppDataDiscoveryStore : IAtomicDiscoveryStore
    {
        private readonly object _sync = new object();
        private readonly string _directory;
        private readonly UTF8Encoding _utf8 = new UTF8Encoding(false);

        public LocalAppDataDiscoveryStore()
            : this(GetDefaultDirectory())
        {
        }

        internal LocalAppDataDiscoveryStore(string directory)
        {
            if (string.IsNullOrWhiteSpace(directory) || !Path.IsPathRooted(directory))
                throw new ArgumentException("Discovery directory must be absolute.", nameof(directory));
            _directory = Path.GetFullPath(directory);
        }

        public void Publish(string hostInstanceId, string content)
        {
            string target = GetTarget(hostInstanceId);
            string temporary = target + "." + Guid.NewGuid().ToString("N") + ".tmp";
            lock (_sync)
            {
                Directory.CreateDirectory(_directory);
                try
                {
                    File.WriteAllText(temporary, content, _utf8);
                    if (File.Exists(target))
                        File.Replace(temporary, target, null);
                    else
                        File.Move(temporary, target);
                }
                finally
                {
                    if (File.Exists(temporary))
                        File.Delete(temporary);
                }
            }
        }

        public void Remove(string hostInstanceId)
        {
            string target = GetTarget(hostInstanceId);
            lock (_sync)
            {
                if (File.Exists(target))
                    File.Delete(target);
            }
        }

        private string GetTarget(string hostInstanceId)
        {
            if (!ProtocolValidation.IsCanonicalGuid(hostInstanceId))
                throw new ArgumentException("Invalid host instance ID.", nameof(hostInstanceId));
            return Path.Combine(_directory, hostInstanceId + ".json");
        }

        private static string GetDefaultDirectory()
        {
            string localAppData = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
            if (string.IsNullOrWhiteSpace(localAppData))
                throw new InvalidOperationException("Local application data is unavailable.");
            return Path.Combine(localAppData, "RevitOperator", "SafeRead", "instances");
        }
    }
}
