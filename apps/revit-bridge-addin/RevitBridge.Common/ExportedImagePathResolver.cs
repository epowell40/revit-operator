using System;
using System.IO;
using System.Linq;
using System.Security.Cryptography;

namespace RevitBridge.Common
{
    public static class ExportedImagePathResolver
    {
        // A new export must use a unique base name. Never attribute the newest
        // unrelated image, or a guessed nonexistent .jpg, to the requested view.
        public static ExportedImageArtifact ReadRequired(string requestedBasePath)
        {
            var directory = Path.GetDirectoryName(requestedBasePath);
            var prefix = Path.GetFileName(requestedBasePath);
            if (string.IsNullOrWhiteSpace(directory) || string.IsNullOrWhiteSpace(prefix) || !Directory.Exists(directory))
                throw new FileNotFoundException("Revit image export directory is unavailable.", requestedBasePath);
            var matches = Directory.GetFiles(directory).Where(path =>
            {
                var name = Path.GetFileName(path);
                var extension = Path.GetExtension(path);
                return new[] { ".png", ".jpg", ".jpeg" }.Contains(extension, StringComparer.OrdinalIgnoreCase)
                    && (string.Equals(Path.GetFileNameWithoutExtension(name), prefix, StringComparison.OrdinalIgnoreCase)
                        || name.StartsWith(prefix + " - ", StringComparison.OrdinalIgnoreCase));
            }).ToArray();
            if (matches.Length != 1)
                throw new InvalidOperationException("Revit image export must produce exactly one image for the unique requested target.");
            using (var stream = File.OpenRead(matches[0]))
            using (var hash = SHA256.Create())
            {
                if (stream.Length == 0) throw new InvalidOperationException("Revit image export is empty.");
                return new ExportedImageArtifact(matches[0], stream.Length,
                    BitConverter.ToString(hash.ComputeHash(stream)).Replace("-", "").ToLowerInvariant());
            }
        }

        public static string Resolve(string requestedBasePath)
        {
            foreach (var candidate in new[]
            {
                requestedBasePath + ".png",
                requestedBasePath + ".jpg",
                requestedBasePath + ".jpeg"
            })
            {
                if (File.Exists(candidate)) return candidate;
            }

            var directory = Path.GetDirectoryName(requestedBasePath);
            var prefix = Path.GetFileName(requestedBasePath);
            if (string.IsNullOrWhiteSpace(directory) || string.IsNullOrWhiteSpace(prefix) || !Directory.Exists(directory))
                return requestedBasePath + ".jpg";

            var exported = Directory.GetFiles(directory, prefix + "*.*")
                .Where(path =>
                    path.EndsWith(".png", StringComparison.OrdinalIgnoreCase) ||
                    path.EndsWith(".jpg", StringComparison.OrdinalIgnoreCase) ||
                    path.EndsWith(".jpeg", StringComparison.OrdinalIgnoreCase))
                .OrderByDescending(File.GetLastWriteTimeUtc)
                .FirstOrDefault();

            return exported ?? requestedBasePath + ".jpg";
        }
    }

    public sealed class ExportedImageArtifact
    {
        public string Path { get; }
        public long Bytes { get; }
        public string Sha256 { get; }
        public ExportedImageArtifact(string path, long bytes, string sha256)
        { Path = path; Bytes = bytes; Sha256 = sha256; }
    }
}
