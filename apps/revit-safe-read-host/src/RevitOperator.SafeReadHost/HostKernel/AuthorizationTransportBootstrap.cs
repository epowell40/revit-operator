using System;
using System.IO;

namespace RevitOperator.SafeReadHost.HostKernel
{
    internal static class AuthorizationTransportBootstrap
    {
        internal const string ProxyOriginEnvironment = "REVIT_OPERATOR_SAFE_READ_PROXY_ORIGIN";

        public static bool TryLoad(
            string? runtimeMode,
            string? directOrigin,
            string? directBearer,
            string? directToken,
            string? proxyOrigin,
            string localApplicationData,
            out FixedBackendOrigin? origin,
            out BackendCredentials? credentials)
        {
            return TryLoad(runtimeMode, directOrigin, directBearer, directToken, proxyOrigin, localApplicationData, ProxyAuthorizationSecretStore.Load, out origin, out credentials);
        }

        internal static bool TryLoad(
            string? runtimeMode,
            string? directOrigin,
            string? directBearer,
            string? directToken,
            string? proxyOrigin,
            string localApplicationData,
            Func<string, byte[]> loadProxySecret,
            out FixedBackendOrigin? origin,
            out BackendCredentials? credentials)
        {
            origin = null;
            credentials = null;
            string mode;
            if (!TryMode(runtimeMode, out mode)) return false;

            if (mode == "hosted" || mode == "production")
            {
                if (directOrigin != null || directBearer != null || directToken != null) return false;
                if (proxyOrigin != null && !String.Equals(proxyOrigin, SafeReadContract.ProxyAuthorizationOrigin, StringComparison.Ordinal)) return false;
                if (!FixedBackendOrigin.TryCreate(SafeReadContract.ProxyAuthorizationOrigin, out origin) || origin == null) return false;
                try
                {
                    byte[] secret = loadProxySecret(localApplicationData);
                    try { credentials = BackendCredentials.CreateProxy(secret); }
                    finally { Array.Clear(secret, 0, secret.Length); }
                    return credentials != null;
                }
                catch { origin = null; credentials = null; return false; }
            }

            if (proxyOrigin != null) return false;
            if (!FixedBackendOrigin.TryCreate(directOrigin, out origin) || origin == null) return false;
            credentials = BackendCredentials.Create(directBearer, directToken);
            if (credentials == null) { origin = null; return false; }
            return true;
        }

        private static bool TryMode(string? raw, out string mode)
        {
            mode = raw ?? "local";
            return mode == "local" || mode == "self_hosted" || mode == "development" || mode == "hosted" || mode == "production";
        }
    }

    internal static class ProxyAuthorizationSecretStore
    {
        public static string PathFor(string localApplicationData)
        {
            if (String.IsNullOrWhiteSpace(localApplicationData) || !String.Equals(localApplicationData, localApplicationData.Trim(), StringComparison.Ordinal))
                throw new InvalidOperationException("Local application data is unavailable.");
            return Path.Combine(Path.GetFullPath(localApplicationData), "RevitOperator", "SafeRead", "proxy", SafeReadContract.ProxyAuthorizationSecretFile);
        }

        public static byte[] Load(string localApplicationData)
        {
            string root = Path.GetFullPath(localApplicationData);
            string path = PathFor(root);
            ValidateFileFacts(File.Exists(path), File.Exists(path) ? File.GetAttributes(path) : default(FileAttributes), File.Exists(path) ? new FileInfo(path).Length : 0);
            using (FileStream stream = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.Read))
            {
                SecureLocalStorage.VerifyPrivateFile(root, path);
                byte[] secret = new byte[32];
                int offset = 0;
                while (offset < secret.Length)
                {
                    int read = stream.Read(secret, offset, secret.Length - offset);
                    if (read <= 0) { Array.Clear(secret, 0, secret.Length); throw new InvalidOperationException("SafeRead proxy authorization secret is invalid."); }
                    offset += read;
                }
                if (stream.ReadByte() != -1) { Array.Clear(secret, 0, secret.Length); throw new InvalidOperationException("SafeRead proxy authorization secret is invalid."); }
                return secret;
            }
        }

        internal static void ValidateFileFacts(bool exists, FileAttributes attributes, long length)
        {
            if (!exists || (attributes & FileAttributes.ReparsePoint) != 0 || length != 32)
                throw new InvalidOperationException("SafeRead proxy authorization secret is unavailable or unsafe.");
        }
    }
}
