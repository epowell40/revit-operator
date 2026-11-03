using System;
using System.Drawing;
using System.IO;
using System.Security.Cryptography;

namespace RevitBridge.Logic
{
    public static class ExportedImageMetadata
    {
        public static (int widthPx, int heightPx) ReadDimensions(string path)
        {
            using (var stream = RevitBridge.Common.ExportedImageFile.OpenRead(path))
            using (var image = Image.FromStream(stream, useEmbeddedColorManagement: false, validateImageData: true))
                return (image.Width, image.Height);
        }

        public static string ComputeSha256(string path)
        {
            using (var stream = RevitBridge.Common.ExportedImageFile.OpenRead(path))
            using (var algorithm = SHA256.Create())
                return "sha256:" + BitConverter.ToString(algorithm.ComputeHash(stream)).Replace("-", "").ToLowerInvariant();
        }

    }
}
