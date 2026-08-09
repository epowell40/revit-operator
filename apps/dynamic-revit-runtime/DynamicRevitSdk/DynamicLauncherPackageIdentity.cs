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

        private static string ComputeCore(string directory)
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
            var duplicate = files.GroupBy(file => file.RelativePath, StringComparer.OrdinalIgnoreCase).FirstOrDefault(group => group.Count() != 1);
            if (duplicate != null) throw new InvalidDataException("Runtime package contains an ambiguous relative path: " + duplicate.Key);

            long totalBytes = 0;
            var canonical = new StringBuilder("dynamic-revit-runtime-package-directory/v1\n");
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
                    if (length > MaximumFileBytes) throw new InvalidDataException("Runtime package file exceeds the byte limit: " + file.RelativePath);
                    totalBytes = checked(totalBytes + length);
                    if (totalBytes > MaximumTotalBytes) throw new InvalidDataException("Runtime package exceeds the aggregate byte limit.");
                    using (var sha256 = SHA256.Create()) fileHash = ToLowerHex(sha256.ComputeHash(stream));
                    if (stream.Length != length) throw new InvalidDataException("Runtime package file changed while it was being identified: " + file.RelativePath);
                }
                RejectReparsePoint(file.FullPath, "Runtime package file");
                canonical.Append(relativePathBytes).Append(':').Append(file.RelativePath).Append(':').Append(length).Append(':').Append(fileHash).Append('\n');
            }

            RejectReparsePoint(root, "Runtime package root");
            using (var sha256 = SHA256.Create()) return ToLowerHex(sha256.ComputeHash(Encoding.UTF8.GetBytes(canonical.ToString())));
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
            public IdentityFile(string fullPath, string relativePath) { FullPath = fullPath; RelativePath = relativePath; }
            public string FullPath { get; }
            public string RelativePath { get; }
        }
    }
}
