using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
using System.Linq;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Threading.Tasks;
using Autodesk.Revit.DB;
using Autodesk.Revit.UI;
using RevitBridge.Common;

namespace RevitBridge.Logic.Handlers
{
    /// <summary>
    /// Captures the Revit window when it is renderable and falls back to an
    /// authoritative active-view export when Revit is minimized or Windows
    /// cannot render the window. This makes the advertised screenshare route
    /// usable by both pane turns and delegated General Agent turns.
    /// </summary>
    public sealed class CaptureScreenshareHandler : IRequestHandler
    {
        private const uint PrintWindowRenderFullContent = 0x00000002;

        public sealed class Params
        {
            public bool includeContext { get; set; } = true;
        }

        public Task<object> Handle(UIApplication app, string jsonData)
        {
            if (app == null) throw new ArgumentNullException(nameof(app));

            var p = string.IsNullOrWhiteSpace(jsonData)
                ? new Params()
                : JsonSerializer.Deserialize<Params>(jsonData) ?? new Params();
            var uidoc = app.ActiveUIDocument ?? throw new InvalidOperationException("No active UI document.");
            var doc = uidoc.Document;
            var view = uidoc.ActiveView ?? throw new InvalidOperationException("No active Revit view.");
            var capturedAt = DateTime.UtcNow;
            var stamp = DateTime.Now.ToString("yyyyMMdd_HHmmss_fff");
            var baseName = $"screenshare_{stamp}";
            var uploadsDir = WorkspacePaths.EnsureDir("artifacts", "uploads");

            var hwnd = Process.GetCurrentProcess().MainWindowHandle;
            var minimized = hwnd != IntPtr.Zero && IsIconic(hwnd);
            var imageFullPath = "";
            var windowCaptureSucceeded = !minimized && TryCaptureRenderableWindow(hwnd, uploadsDir, baseName, out imageFullPath);
            var captureMode = CaptureScreensharePolicy.SelectCaptureMode(minimized, windowCaptureSucceeded);
            if (!windowCaptureSucceeded)
            {
                imageFullPath = ExportActiveView(doc, uidoc, view, uploadsDir, baseName);
            }

            var imageName = Path.GetFileName(imageFullPath);
            var imageRelativePath = ("artifacts/uploads/" + imageName).Replace("\\", "/");
            var imageMime = MimeForPath(imageFullPath);
            var imageInfo = new FileInfo(imageFullPath);
            var imageSha = ComputeSha256Hex(imageFullPath);
            var imageId = Guid.NewGuid().ToString("N");

            string? contextFullPath = null;
            string? contextRelativePath = null;
            string? contextSha = null;
            long? contextBytes = null;
            string? contextId = null;
            if (p.includeContext)
            {
                var contextName = baseName + "_context.json";
                contextFullPath = Path.Combine(uploadsDir, contextName);
                contextRelativePath = ("artifacts/uploads/" + contextName).Replace("\\", "/");
                var context = BuildContext(uidoc, doc, view, capturedAt, captureMode, minimized);
                File.WriteAllText(
                    contextFullPath,
                    JsonSerializer.Serialize(context, new JsonSerializerOptions { WriteIndented = true }) + "\n",
                    new UTF8Encoding(false));
                var contextInfo = new FileInfo(contextFullPath);
                contextBytes = contextInfo.Length;
                contextSha = ComputeSha256Hex(contextFullPath);
                contextId = Guid.NewGuid().ToString("N");
            }

            var createdAt = capturedAt.ToString("o");
            AppendUploadIndex(new
            {
                id = imageId,
                relative_path = imageRelativePath,
                filename = imageName,
                bytes = imageInfo.Length,
                sha256 = imageSha,
                mime = imageMime,
                created_at = createdAt,
                kind = "screenshare",
                capture_mode = captureMode,
                context_relative_path = contextRelativePath
            });
            if (!string.IsNullOrWhiteSpace(contextFullPath))
            {
                AppendUploadIndex(new
                {
                    id = contextId,
                    relative_path = contextRelativePath,
                    filename = Path.GetFileName(contextFullPath),
                    bytes = contextBytes,
                    sha256 = contextSha,
                    mime = "application/json",
                    created_at = createdAt,
                    kind = "screenshare_context",
                    capture_mode = captureMode,
                    related_image_relative_path = imageRelativePath
                });
            }

            var files = new List<object>
            {
                new
                {
                    id = imageId,
                    path = imageFullPath,
                    relative_path = imageRelativePath,
                    filename = imageName,
                    bytes = imageInfo.Length,
                    sha256 = imageSha,
                    mime = imageMime,
                    created_at = createdAt
                }
            };
            if (!string.IsNullOrWhiteSpace(contextFullPath))
            {
                files.Add(new
                {
                    id = contextId,
                    path = contextFullPath,
                    relative_path = contextRelativePath,
                    filename = Path.GetFileName(contextFullPath),
                    bytes = contextBytes,
                    sha256 = contextSha,
                    mime = "application/json",
                    created_at = createdAt
                });
            }

            return Task.FromResult<object>(new
            {
                ok = true,
                kind = "screenshare",
                capture_mode = captureMode,
                minimized_fallback = minimized,
                fallback_used = captureMode == "active_view_export",
                captured_at = createdAt,
                path = imageFullPath,
                relative_path = imageRelativePath,
                sha256 = imageSha,
                bytes = imageInfo.Length,
                mime = imageMime,
                context_path = contextFullPath,
                context_relative_path = contextRelativePath,
                files = files.ToArray()
            });
        }

        private static object BuildContext(
            UIDocument uidoc,
            Document doc,
            View view,
            DateTime capturedAt,
            string captureMode,
            bool minimized)
        {
            var selectionIds = new List<long>();
            try
            {
                selectionIds.AddRange(uidoc.Selection.GetElementIds().Select(ElementIdCompat.GetValue));
            }
            catch
            {
                // Context is additive evidence; image capture remains useful if selection lookup fails.
            }

            object? zoom = null;
            try
            {
                var uiView = uidoc.GetOpenUIViews()
                    .FirstOrDefault(candidate => ElementIdCompat.GetValue(candidate.ViewId) == ElementIdCompat.GetValue(view.Id));
                var corners = uiView?.GetZoomCorners();
                if (corners != null && corners.Count >= 2)
                {
                    var a = corners[0];
                    var b = corners[1];
                    zoom = new
                    {
                        minX = Math.Min(a.X, b.X),
                        minY = Math.Min(a.Y, b.Y),
                        minZ = Math.Min(a.Z, b.Z),
                        maxX = Math.Max(a.X, b.X),
                        maxY = Math.Max(a.Y, b.Y),
                        maxZ = Math.Max(a.Z, b.Z),
                        note = "feet, model coordinates (UIView.GetZoomCorners)"
                    };
                }
            }
            catch
            {
                zoom = null;
            }

            string? sheetNumber = null;
            string? sheetName = null;
            if (view is ViewSheet sheet)
            {
                sheetNumber = sheet.SheetNumber;
                sheetName = sheet.Name;
            }

            int? scale = null;
            try { scale = view.Scale; } catch { }

            return new
            {
                captured_at = capturedAt.ToString("o"),
                capture_mode = captureMode,
                window_state = minimized ? "minimized" : "visible_or_occluded",
                revit = new
                {
                    document_title = doc.Title,
                    document_path = doc.PathName,
                    active_view = new
                    {
                        id = ElementIdCompat.GetValue(view.Id),
                        name = view.Name,
                        view_type = view.ViewType.ToString(),
                        scale,
                        sheet_number = sheetNumber,
                        sheet_name = sheetName
                    },
                    selection_ids = selectionIds.OrderBy(id => id).ToArray(),
                    zoom_corners = zoom
                },
                note = captureMode == "active_view_export"
                    ? "Revit was minimized or its window was not renderable, so the authoritative active view was exported for visual grounding."
                    : "The renderable Revit main window was captured for visual grounding."
            };
        }

        private static bool TryCaptureRenderableWindow(IntPtr hwnd, string uploadsDir, string baseName, out string imageFullPath)
        {
            imageFullPath = "";
            if (hwnd == IntPtr.Zero || !GetWindowRect(hwnd, out var rect)) return false;
            var width = Math.Max(1, rect.Right - rect.Left);
            var height = Math.Max(1, rect.Bottom - rect.Top);

            try
            {
                using var bitmap = new Bitmap(width, height, PixelFormat.Format24bppRgb);
                bool printed;
                using (var graphics = Graphics.FromImage(bitmap))
                {
                    var hdc = graphics.GetHdc();
                    try { printed = PrintWindow(hwnd, hdc, PrintWindowRenderFullContent); }
                    finally { graphics.ReleaseHdc(hdc); }
                }
                if (!printed || !HasVisiblePixels(bitmap)) return false;

                using var final = DownscaleIfNeeded(bitmap, 2200);
                imageFullPath = Path.Combine(uploadsDir, baseName + ".jpg");
                SaveJpeg(imageFullPath, final, 80L);
                return File.Exists(imageFullPath) && new FileInfo(imageFullPath).Length > 0;
            }
            catch
            {
                imageFullPath = "";
                return false;
            }
        }

        private static string ExportActiveView(Document doc, UIDocument uidoc, View view, string uploadsDir, string baseName)
        {
            try { doc.Regenerate(); } catch { }
            try { uidoc.RefreshActiveView(); } catch { }

            var fileBase = Path.Combine(uploadsDir, baseName);
            var options = new ImageExportOptions
            {
                ZoomType = ZoomFitType.FitToPage,
                PixelSize = 2048,
                FilePath = fileBase,
                FitDirection = FitDirectionType.Horizontal,
                ExportRange = ExportRange.SetOfViews
            };
            options.SetViewsAndSheets(new List<ElementId> { view.Id });
            doc.ExportImage(options);

            var actual = Directory.EnumerateFiles(uploadsDir, baseName + "*")
                .Where(path =>
                {
                    var extension = Path.GetExtension(path);
                    return extension.Equals(".png", StringComparison.OrdinalIgnoreCase)
                        || extension.Equals(".jpg", StringComparison.OrdinalIgnoreCase)
                        || extension.Equals(".jpeg", StringComparison.OrdinalIgnoreCase);
                })
                .OrderByDescending(path => File.GetLastWriteTimeUtc(path))
                .FirstOrDefault();
            if (string.IsNullOrWhiteSpace(actual) || !File.Exists(actual))
                throw new InvalidOperationException("Revit active-view export produced no image artifact.");
            return actual;
        }

        private static bool HasVisiblePixels(Bitmap bitmap)
        {
            var stepX = Math.Max(1, bitmap.Width / 24);
            var stepY = Math.Max(1, bitmap.Height / 16);
            for (var y = 0; y < bitmap.Height; y += stepY)
            {
                for (var x = 0; x < bitmap.Width; x += stepX)
                {
                    var pixel = bitmap.GetPixel(x, y);
                    if (pixel.R > 12 || pixel.G > 12 || pixel.B > 12) return true;
                }
            }
            return false;
        }

        private static Bitmap DownscaleIfNeeded(Bitmap source, int maxSidePixels)
        {
            var maxSide = Math.Max(source.Width, source.Height);
            if (maxSide <= maxSidePixels) return (Bitmap)source.Clone();
            var scale = (double)maxSidePixels / maxSide;
            var width = Math.Max(1, (int)Math.Round(source.Width * scale));
            var height = Math.Max(1, (int)Math.Round(source.Height * scale));
            var result = new Bitmap(width, height, PixelFormat.Format24bppRgb);
            using var graphics = Graphics.FromImage(result);
            graphics.InterpolationMode = System.Drawing.Drawing2D.InterpolationMode.HighQualityBicubic;
            graphics.DrawImage(source, 0, 0, width, height);
            return result;
        }

        private static void SaveJpeg(string fullPath, Bitmap bitmap, long quality)
        {
            var codec = ImageCodecInfo.GetImageEncoders().FirstOrDefault(candidate => candidate.FormatID == ImageFormat.Jpeg.Guid);
            if (codec == null)
            {
                bitmap.Save(fullPath, ImageFormat.Jpeg);
                return;
            }

            using var parameters = new EncoderParameters(1);
            parameters.Param[0] = new EncoderParameter(System.Drawing.Imaging.Encoder.Quality, quality);
            bitmap.Save(fullPath, codec, parameters);
        }

        private static string MimeForPath(string path)
        {
            return Path.GetExtension(path).Equals(".png", StringComparison.OrdinalIgnoreCase)
                ? "image/png"
                : "image/jpeg";
        }

        private static string ComputeSha256Hex(string fullPath)
        {
            using var sha = SHA256.Create();
            using var stream = File.OpenRead(fullPath);
            var hash = sha.ComputeHash(stream);
            var result = new StringBuilder(hash.Length * 2);
            foreach (var value in hash) result.Append(value.ToString("x2"));
            return result.ToString();
        }

        private static void AppendUploadIndex(object record)
        {
            try
            {
                var indexPath = WorkspacePaths.ResolveFileUnderWorkspace(Path.Combine("artifacts", "uploads", "_uploads.jsonl"));
                var line = JsonSerializer.Serialize(record) + "\n";
                File.AppendAllText(indexPath, line, new UTF8Encoding(false));
            }
            catch
            {
                // The capture receipt remains authoritative even if the convenience index cannot be updated.
            }
        }

        [DllImport("user32.dll")]
        private static extern bool GetWindowRect(IntPtr hWnd, out WindowRect rect);

        [DllImport("user32.dll")]
        private static extern bool IsIconic(IntPtr hWnd);

        [DllImport("user32.dll")]
        private static extern bool PrintWindow(IntPtr hWnd, IntPtr hdcBlt, uint flags);

        [StructLayout(LayoutKind.Sequential)]
        private struct WindowRect
        {
            public int Left;
            public int Top;
            public int Right;
            public int Bottom;
        }
    }
}
