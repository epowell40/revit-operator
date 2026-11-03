using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Security.Cryptography;
using System.Text;

namespace RevitOperator.DynamicRevitSdk
{
    /// <summary>
    /// Computes the complete identity of an immutable runtime package directory. Both
    /// the launcher and the Revit host use this implementation so bootstrap cannot omit
    /// a managed dependency, runtime configuration file, or nested policy manifest.
    /// </summary>
    public static class DynamicRuntimePackageDirectoryIdentity
    {
        public const int MaximumFileCount = 256;
        public const long MaximumFileBytes = 256L * 1024 * 1024;
        public const long MaximumTotalBytes = 512L * 1024 * 1024;
        public const int MaximumRelativePathUtf8Bytes = 1024;

        public static string Compute(string directory)
        {
            if (string.IsNullOrWhiteSpace(directory)) throw new ArgumentException("Runtime package directory is required.", nameof(directory));
            try { return ComputeCore(directory); }
            catch (InvalidDataException) { throw; }
            catch (Exception exception) when (exception is IOException || exception is UnauthorizedAccessException || exception is CryptographicException)
            {
                throw new InvalidDataException("Runtime package identity could not be computed safely.", exception);
            }
        }

        // Computes the exact staged image without copying it into the Revit host.
        // Paths come only from the host-selected installed target, never generated
        // code. The unchanged base package must still match its trusted pin. Both
        // identities use the same observed base bytes, including every dependency.
        public static string ComputeWithNativeTarget2024(string directory, string trustedBaseHash,
            IReadOnlyDictionary<string, string> installedReferences)
            => ComputeWithNativeTarget(directory, trustedBaseHash, installedReferences);

        public static string ComputeWithNativeTarget(string directory, string trustedBaseHash,
            IReadOnlyDictionary<string, string> installedReferences)
        {
            if (installedReferences == null || !DynamicNativeTargetProfile.KnownReferenceNames(installedReferences.Keys) ||
                installedReferences.Values.Any(string.IsNullOrWhiteSpace))
                throw new InvalidDataException("Native target requires its exact installed framework reference profile.");
            if (string.IsNullOrWhiteSpace(trustedBaseHash)) throw new InvalidDataException("Trusted base package identity is required.");
            try { return ComputeCore(directory, trustedBaseHash, installedReferences); }
            catch (InvalidDataException) { throw; }
            catch (Exception exception) when (exception is IOException || exception is UnauthorizedAccessException || exception is CryptographicException)
            { throw new InvalidDataException("Native target package identity could not be computed safely.", exception); }
        }

        private static string ComputeCore(string directory, string? trustedBaseHash = null,
            IReadOnlyDictionary<string, string>? installedReferences = null)
        {
            var fullRoot = Path.GetFullPath(directory);
            var root = fullRoot.TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
            var volumeRoot = (Path.GetPathRoot(fullRoot) ?? "").TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
            if (string.Equals(root, volumeRoot, StringComparison.OrdinalIgnoreCase)) throw new InvalidDataException("A filesystem root may not be used as a runtime package directory.");
            if (!Directory.Exists(root)) throw new DirectoryNotFoundException(root);
            RejectReparsePoint(root, "Runtime package root");

            var pending = new Stack<string>();
            pending.Push(root);
            var files = new List<IdentityFile>();
            while (pending.Count > 0)
            {
                var current = pending.Pop();
                RejectReparsePoint(current, "Runtime package directory");
                string[] entries;
                try { entries = Directory.GetFileSystemEntries(current, "*", SearchOption.TopDirectoryOnly); }
                catch (Exception exception) { throw new InvalidDataException("Runtime package directory could not be enumerated safely.", exception); }

                foreach (var entry in entries)
                {
                    var fullPath = Path.GetFullPath(entry);
                    EnsureContained(root, fullPath);
                    var attributes = File.GetAttributes(fullPath);
                    if ((attributes & FileAttributes.ReparsePoint) != 0) throw new InvalidDataException("Runtime package may not contain reparse points: " + RelativePath(root, fullPath));
                    if ((attributes & FileAttributes.Directory) != 0)
                    {
                        pending.Push(fullPath);
                        continue;
                    }

                    files.Add(new IdentityFile(fullPath, RelativePath(root, fullPath)));
                    if (files.Count > MaximumFileCount) throw new InvalidDataException("Runtime package exceeds the file-count limit.");
                }
                RejectReparsePoint(current, "Runtime package directory");
            }

            if (files.Count == 0) throw new InvalidDataException("Runtime package identity has no files.");
            if (installedReferences != null)
            {
                if (Directory.Exists(Path.Combine(root, "native-target")) || File.Exists(Path.Combine(root, "native-target")))
                    throw new InvalidDataException("Installed base package already contains a native target overlay.");
                foreach (var pair in installedReferences)
                {
                    var path = Path.GetFullPath(pair.Value);
                    RejectReferenceReparsePoints(path);
                    files.Add(new IdentityFile(path, "native-target/2024/" + pair.Key + ".dll", true));
                }
                if (files.Count > MaximumFileCount) throw new InvalidDataException("Runtime package with native references exceeds the file-count limit.");
            }
            var duplicate = files.GroupBy(file => file.RelativePath, StringComparer.OrdinalIgnoreCase).FirstOrDefault(group => group.Count() != 1);
            if (duplicate != null) throw new InvalidDataException("Runtime package contains an ambiguous relative path: " + duplicate.Key);

            long totalBytes = 0;
            var canonical = new StringBuilder("dynamic-revit-runtime-package-directory/v1\n");
            var baseCanonical = new StringBuilder("dynamic-revit-runtime-package-directory/v1\n");
            foreach (var file in files.OrderBy(file => file.RelativePath, StringComparer.Ordinal))
            {
                var relativePathBytes = Encoding.UTF8.GetByteCount(file.RelativePath);
                if (relativePathBytes > MaximumRelativePathUtf8Bytes) throw new InvalidDataException("Runtime package path exceeds the UTF-8 length limit: " + file.RelativePath);
                RejectReparsePoint(file.FullPath, "Runtime package file");
                string fileHash;
                long length;
                using (var stream = new FileStream(file.FullPath, FileMode.Open, FileAccess.Read, FileShare.Read, 64 * 1024, FileOptions.SequentialScan))
                {
                    length = stream.Length;
                    if (file.NativeReference && (length < 1 || length > 64L * 1024 * 1024))
                        throw new InvalidDataException("Native target reference exceeds the byte limit.");
                    if (length > MaximumFileBytes) throw new InvalidDataException("Runtime package file exceeds the byte limit: " + file.RelativePath);
                    totalBytes = checked(totalBytes + length);
                    if (totalBytes > MaximumTotalBytes) throw new InvalidDataException("Runtime package exceeds the aggregate byte limit.");
                    using (var sha256 = SHA256.Create()) fileHash = ToLowerHex(sha256.ComputeHash(stream));
                    if (stream.Length != length) throw new InvalidDataException("Runtime package file changed while it was being identified: " + file.RelativePath);
                }
                RejectReparsePoint(file.FullPath, "Runtime package file");
                if (file.NativeReference) RejectReferenceReparsePoints(file.FullPath);
                var line = relativePathBytes + ":" + file.RelativePath + ":" + length + ":" + fileHash + "\n";
                canonical.Append(line);
                if (!file.NativeReference) baseCanonical.Append(line);
            }

            RejectReparsePoint(root, "Runtime package root");
            if (installedReferences != null && DynamicWire.Sha256(baseCanonical.ToString()) != trustedBaseHash)
                throw new InvalidDataException("Installed base compiler package differs from its trusted identity.");
            using (var sha256 = SHA256.Create()) return "sha256:" + ToLowerHex(sha256.ComputeHash(Encoding.UTF8.GetBytes(canonical.ToString())));
        }

        private static void RejectReferenceReparsePoints(string path)
        {
            RejectReparsePoint(path, "Native target reference");
            for (var parent = Directory.GetParent(path); parent != null; parent = parent.Parent)
                RejectReparsePoint(parent.FullName, "Native target reference ancestor");
        }

        private static string RelativePath(string root, string path)
        {
            var prefix = root + Path.DirectorySeparatorChar;
            if (!path.StartsWith(prefix, StringComparison.OrdinalIgnoreCase)) throw new InvalidDataException("Runtime package entry resolves outside its root.");
            return path.Substring(prefix.Length).Replace('\\', '/');
        }

        private static void EnsureContained(string root, string path)
        {
            var prefix = root + Path.DirectorySeparatorChar;
            if (!path.StartsWith(prefix, StringComparison.OrdinalIgnoreCase)) throw new InvalidDataException("Runtime package entry resolves outside its root.");
        }

        private static void RejectReparsePoint(string path, string kind)
        {
            if ((File.GetAttributes(path) & FileAttributes.ReparsePoint) != 0) throw new InvalidDataException(kind + " may not be a reparse point: " + path);
        }

        private static string ToLowerHex(byte[] bytes)
        {
            var result = new StringBuilder(bytes.Length * 2);
            foreach (var value in bytes) result.Append(value.ToString("x2"));
            return result.ToString();
        }

        private sealed class IdentityFile
        {
            public IdentityFile(string fullPath, string relativePath, bool nativeReference = false) { FullPath = fullPath; RelativePath = relativePath; NativeReference = nativeReference; }
            public string FullPath { get; }
            public string RelativePath { get; }
            public bool NativeReference { get; }
        }
    }
}
