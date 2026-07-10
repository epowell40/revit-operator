using System;
using System.IO;
using System.Linq;

namespace RevitBridge.Common
{
    public static class ExportedImagePathResolver
    {
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
}
