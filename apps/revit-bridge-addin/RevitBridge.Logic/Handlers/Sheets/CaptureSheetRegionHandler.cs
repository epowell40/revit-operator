using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
using System.Linq;
using System.Net.Http;
using System.Text;
using System.Text.Json;
using System.Threading.Tasks;
using System.Runtime.InteropServices;
using Autodesk.Revit.DB;
using Autodesk.Revit.UI;
using RevitBridge.Common;

namespace RevitBridge.Logic.Handlers
{
    public sealed class CaptureSheetRegionHandler : RevitBridge.Common.IRequestHandler
    {
        public sealed class Params
        {
            public string? sheetNumber { get; set; }
            public long? sheetViewId { get; set; }

            // Currently only "titleblock" is supported.
            public string region { get; set; } = "titleblock";

            public double marginFt { get; set; } = 0.15;
            public int imageMaxSizePx { get; set; } = 2400;
            public bool includeMapping { get; set; } = true;
            public string? fileName { get; set; }

            // Optional: OCR the exported image via the local Operator backend (best-effort).
            public bool includeOcr { get; set; } = false;
            public string ocrKind { get; set; } = "date"; // date | text
            public string? ocrExpected { get; set; }
            public int ocrTimeoutMs { get; set; } = 20000;
            public int ocrMaxRetries { get; set; } = 2;
            public bool ocrPreprocess { get; set; } = false;
        }

        public Task<object> Handle(UIApplication app, string jsonData)
        {
            var p = string.IsNullOrEmpty(jsonData) ? new Params() : (JsonSerializer.Deserialize<Params>(jsonData) ?? new Params());
            var uidoc = app.ActiveUIDocument;
            if (uidoc == null) throw new InvalidOperationException("No active UI document.");
            var doc = uidoc.Document;

            ViewSheet? sheet = null;
            if (p.sheetViewId.HasValue && p.sheetViewId.Value != 0)
            {
                sheet = doc.GetElement(RevitBridge.Common.ElementIdCompat.Create(p.sheetViewId.Value)) as ViewSheet;
            }
            else if (!string.IsNullOrWhiteSpace(p.sheetNumber))
            {
                var target = (p.sheetNumber ?? "").Trim();
                sheet = new FilteredElementCollector(doc)
                    .OfClass(typeof(ViewSheet))
                    .Cast<ViewSheet>()
                    .FirstOrDefault(s => string.Equals((s.SheetNumber ?? "").Trim(), target, StringComparison.OrdinalIgnoreCase));
            }

            if (sheet == null) throw new InvalidOperationException("Sheet not found (provide sheetViewId or sheetNumber).");

            var mode = (p.region ?? "").Trim().ToLowerInvariant();
            if (mode != "titleblock") throw new InvalidOperationException("capture-sheet-region.region must be 'titleblock'.");

            var warnings = new List<string>();
            try
            {
                // Make verification sheet-aware: activate the sheet view before capture (best-effort).
                // This reduces the chance of exporting stale cached graphics from a non-active sheet.
                if (uidoc.ActiveView == null || uidoc.ActiveView.Id != sheet.Id)
                {
                    uidoc.ActiveView = sheet;
                }
            }
            catch (Exception ex)
            {
                warnings.Add($"Could not activate sheet view {RevitBridge.Common.ElementIdCompat.GetValue(sheet.Id)} ('{sheet.Name}'): {ex.Message}");
            }

            object? ocrCapabilities = null;
            bool ocrReady = false;
            try
            {
                ocrCapabilities = OcrCapabilitiesViaBackend(p.ocrTimeoutMs).GetAwaiter().GetResult();
                try
                {
                    var capsJson = JsonSerializer.Serialize(ocrCapabilities);
                    using var jd = JsonDocument.Parse(capsJson);
                    if (jd.RootElement.TryGetProperty("ocrReady", out var oe) && (oe.ValueKind == JsonValueKind.True || oe.ValueKind == JsonValueKind.False))
                        ocrReady = oe.GetBoolean();
                }
                catch
                {
                    // ignore parse
                }
            }
            catch (Exception ex)
            {
                ocrReady = false;
                warnings.Add("OCR capability check failed: " + ex.Message);
            }

            var titleblocks = new FilteredElementCollector(doc, sheet.Id)
                .OfCategory(BuiltInCategory.OST_TitleBlocks)
                .WhereElementIsNotElementType()
                .ToElements();

            var focusIds = new List<long>();
            foreach (var tb in titleblocks)
            {
                try { if (tb?.Id != null && tb.Id != ElementId.InvalidElementId) focusIds.Add(RevitBridge.Common.ElementIdCompat.GetValue(tb.Id)); } catch { }
            }
            if (focusIds.Count == 0) throw new InvalidOperationException("No titleblock instance found on the target sheet.");

            var export = new RevitBridge.Logic.Handlers.ExportViewRegionHandler.Params
            {
                viewId = RevitBridge.Common.ElementIdCompat.GetValue(sheet.Id),
                imageMaxSizePx = p.imageMaxSizePx,
                includeMapping = p.includeMapping,
                fileName = p.fileName,
                region = new RevitBridge.Logic.Handlers.ExportViewRegionHandler.RegionSpec
                {
                    mode = "focusElements",
                    focusElementIds = focusIds,
                    marginFt = p.marginFt
                }
            };

            object exportResult;
            try
            {
                // Preferred: deterministic region export (includes mapping metadata). This does not work for DrawingSheet views.
                var exportJson = JsonSerializer.Serialize(export);
                exportResult = new RevitBridge.Logic.Handlers.ExportViewRegionHandler().Handle(app, exportJson).GetAwaiter().GetResult();
            }
            catch (Exception ex)
            {
                // Sheets (ViewType.DrawingSheet) do not support crop boxes; fall back to exporting the full sheet image.
                warnings.Add($"capture-sheet-region falling back to full-sheet export (region crop not supported for sheets): {ex.Message}");

                var folder = SelectionUtil.EnsureDefaultSelectionCaptureFolder(null);
                var frameId = Guid.NewGuid().ToString("N");
                var stem = (p.fileName ?? "").Trim();
                if (string.IsNullOrWhiteSpace(stem))
                {
                    stem = $"Sheet_{RevitBridge.Common.ElementIdCompat.GetValue(sheet.Id)}_{frameId}_titleblock";
                }
                else
                {
                    foreach (var c in System.IO.Path.GetInvalidFileNameChars()) stem = stem.Replace(c, '_');
                }

                try { doc.Regenerate(); } catch { }
                try { uidoc.RefreshActiveView(); } catch { }

                var px = Math.Max(256, Math.Min(8192, p.imageMaxSizePx));
                if (p.includeOcr) px = Math.Max(px, 3600); // OCR benefits from higher DPI on sheets.
                var path = SelectionUtil.ExportViewImage(doc, sheet, px, folder, stem);
                var (widthPx, heightPx) = SelectionUtil.ReadImageSize(path);

                // Best-effort: crop down to the titleblock bounds so OCR is faster and more accurate.
                try
                {
                    if (TryCropTitleblockFromFullSheetExport(doc, sheet, focusIds, path, widthPx, heightPx, p.marginFt, out var croppedPath, out var cw, out var ch, out var cropWarning))
                    {
                        if (!string.IsNullOrWhiteSpace(cropWarning)) warnings.Add(cropWarning);
                        path = croppedPath;
                        widthPx = cw;
                        heightPx = ch;
                    }
                }
                catch (Exception cx)
                {
                    warnings.Add("Titleblock crop failed (using full-sheet image): " + cx.Message);
                }

                exportResult = new
                {
                    frameId,
                    viewId = RevitBridge.Common.ElementIdCompat.GetValue(sheet.Id),
                    viewType = sheet.ViewType.ToString(),
                    viewName = sheet.Name,
                    path,
                    widthPx,
                    heightPx,
                    mapping = (object?)null,
                    warnings = warnings.Count > 0 ? warnings : null
                };
            }

            object? ocr = null;
            int? ocrAttempts = null;
            List<string>? ocrErrors = null;
            if (p.includeOcr)
            {
                try
                {
                    var exportStr = JsonSerializer.Serialize(exportResult);
                    using var jd = JsonDocument.Parse(exportStr);
                    var path = jd.RootElement.TryGetProperty("path", out var pe) && pe.ValueKind == JsonValueKind.String ? (pe.GetString() ?? "") : "";

                    if (!string.IsNullOrWhiteSpace(path))
                    {
                        var ocrPath = path;
                        if (p.ocrPreprocess)
                        {
                            try
                            {
                                ocrPath = PreprocessForOcr(path);
                            }
                            catch (Exception pex)
                            {
                                warnings.Add("OCR preprocess failed (using original image): " + pex.Message);
                                ocrPath = path;
                            }
                        }

                        var rr = OcrViaBackendWithRetry(ocrPath, p.ocrKind, p.ocrExpected, p.ocrTimeoutMs, p.ocrMaxRetries).GetAwaiter().GetResult();
                        ocr = rr.Ocr;
                        ocrAttempts = rr.Attempts;
                        ocrErrors = rr.Errors;
                    }
                    else
                    {
                        ocr = new { ok = false, error = "Export did not return a path for OCR." };
                    }
                }
                catch (System.Exception ex)
                {
                    ocr = new { ok = false, error = "OCR failed: " + ex.Message };
                }
            }

            return Task.FromResult<object>(new
            {
                sheetNumber = sheet.SheetNumber,
                sheetViewId = RevitBridge.Common.ElementIdCompat.GetValue(sheet.Id),
                region = mode,
                export = exportResult,
                ocrReady,
                ocrCapabilities,
                ocr,
                ocrAttempts,
                ocrErrors = ocrErrors != null && ocrErrors.Count > 0 ? ocrErrors : null,
                warnings = warnings.Count > 0 ? warnings : null
            });
        }

        private static string PreprocessForOcr(string srcPath)
        {
            if (string.IsNullOrWhiteSpace(srcPath) || !File.Exists(srcPath)) return srcPath;
            var dir = Path.GetDirectoryName(srcPath) ?? "";
            var stem = Path.GetFileNameWithoutExtension(srcPath) ?? "image";
            var outPath = Path.Combine(dir, stem + "_ocr.png");

            using (var src0 = new Bitmap(srcPath))
            {
                // Downscale before thresholding for speed + OCR stability.
                var maxDim = 2600;
                Bitmap src;
                if (Math.Max(src0.Width, src0.Height) > maxDim)
                {
                    var scale = maxDim / (double)Math.Max(1, Math.Max(src0.Width, src0.Height));
                    var w = Math.Max(1, (int)Math.Round(src0.Width * scale));
                    var h = Math.Max(1, (int)Math.Round(src0.Height * scale));
                    src = new Bitmap(w, h, PixelFormat.Format24bppRgb);
                    using (var g = Graphics.FromImage(src))
                    {
                        g.InterpolationMode = System.Drawing.Drawing2D.InterpolationMode.HighQualityBilinear;
                        g.SmoothingMode = System.Drawing.Drawing2D.SmoothingMode.None;
                        g.PixelOffsetMode = System.Drawing.Drawing2D.PixelOffsetMode.HighQuality;
                        g.DrawImage(src0, new System.Drawing.Rectangle(0, 0, w, h));
                    }
                }
                else
                {
                    src = new Bitmap(src0);
                }

                try
                {
                    using (src)
                    using (var dst = new Bitmap(src.Width, src.Height, PixelFormat.Format24bppRgb))
                    {
                        // Fast threshold using LockBits (avoid slow GetPixel/SetPixel loops).
                        var rect = new System.Drawing.Rectangle(0, 0, src.Width, src.Height);
                        using (var g2 = Graphics.FromImage(dst))
                        {
                            g2.DrawImage(src, rect);
                        }

                        var data = dst.LockBits(rect, ImageLockMode.ReadWrite, PixelFormat.Format24bppRgb);
                        try
                        {
                            var bytes = Math.Abs(data.Stride) * data.Height;
                            var buf = new byte[bytes];
                            Marshal.Copy(data.Scan0, buf, 0, bytes);

                            const int threshold = 180;
                            for (int y = 0; y < data.Height; y++)
                            {
                                var row = y * data.Stride;
                                for (int x = 0; x < data.Width; x++)
                                {
                                    var i = row + x * 3;
                                    var b = buf[i + 0];
                                    var gch = buf[i + 1];
                                    var r = buf[i + 2];
                                    // Integer luma approx: (0.299,0.587,0.114)
                                    var lum = (r * 77 + gch * 150 + b * 29) >> 8;
                                    var v = lum > threshold ? (byte)255 : (byte)0;
                                    buf[i + 0] = v;
                                    buf[i + 1] = v;
                                    buf[i + 2] = v;
                                }
                            }

                            Marshal.Copy(buf, 0, data.Scan0, bytes);
                        }
                        finally
                        {
                            dst.UnlockBits(data);
                        }

                        dst.Save(outPath, ImageFormat.Png);
                    }
                }
                finally
                {
                    // src disposed via using
                }
            }

            return outPath;
        }

        private static bool IsRetryableOcrError(string msg)
        {
            if (string.IsNullOrWhiteSpace(msg)) return false;
            var m = msg.ToLowerInvariant();
            if (m.Contains("task was canceled")) return true;
            if (m.Contains("timed out")) return true;
            if (m.Contains("timeout")) return true;
            if (m.Contains("temporar")) return true;
            return false;
        }

        private sealed class OcrRetryResult
        {
            public object Ocr = new { ok = false, error = "OCR not attempted." };
            public int Attempts = 0;
            public List<string> Errors = new List<string>();
        }

        private static async Task<OcrRetryResult> OcrViaBackendWithRetry(string imagePath, string? kind, string? expected, int timeoutMs, int maxRetries)
        {
            var retries = Math.Max(0, Math.Min(4, maxRetries));
            var baseTimeout = Math.Max(500, timeoutMs);
            var tryTimeouts = new List<int>();
            // Fast initial attempt, then longer retries.
            tryTimeouts.Add(Math.Min(baseTimeout, 8000));
            for (int i = 0; i < retries; i++)
            {
                var t = baseTimeout;
                if (i >= 0) t = Math.Max(t, 20000);
                if (i >= 1) t = Math.Max(t, 45000);
                if (i >= 2) t = Math.Max(t, 120000);
                tryTimeouts.Add(t);
            }

            var result = new OcrRetryResult();

            for (int i = 0; i < tryTimeouts.Count; i++)
            {
                var tms = tryTimeouts[i];
                try
                {
                    result.Ocr = await OcrViaBackend(imagePath, kind, expected, tms).ConfigureAwait(false);

                    try
                    {
                        var json = JsonSerializer.Serialize(result.Ocr);
                        using var jd = JsonDocument.Parse(json);
                        if (jd.RootElement.TryGetProperty("ok", out var ok) && ok.ValueKind == JsonValueKind.True)
                        {
                            result.Attempts = i + 1;
                            return result;
                        }
                        var err = jd.RootElement.TryGetProperty("error", out var ee) && ee.ValueKind == JsonValueKind.String ? (ee.GetString() ?? "") : "";
                        if (!string.IsNullOrWhiteSpace(err)) result.Errors.Add(err);
                        if (!IsRetryableOcrError(err)) break;
                    }
                    catch
                    {
                        // If we can't parse, assume non-retryable.
                        break;
                    }
                }
                catch (Exception ex)
                {
                    result.Errors.Add(ex.Message);
                    if (!IsRetryableOcrError(ex.Message)) break;
                }

                // Exponential-ish backoff.
                var backoff = 200 * (int)Math.Pow(3, Math.Min(3, i));
                try { await Task.Delay(backoff).ConfigureAwait(false); } catch { }
            }

            result.Attempts = tryTimeouts.Count;
            return result;
        }

        private static bool TryCropTitleblockFromFullSheetExport(Document doc, ViewSheet sheet, List<long> focusIds, string fullSheetPath, int widthPx, int heightPx, double marginFt, out string croppedPath, out int croppedWidthPx, out int croppedHeightPx, out string? warning)
        {
            croppedPath = fullSheetPath;
            croppedWidthPx = widthPx;
            croppedHeightPx = heightPx;
            warning = null;

            if (focusIds == null || focusIds.Count == 0) return false;
            if (string.IsNullOrWhiteSpace(fullSheetPath) || !File.Exists(fullSheetPath)) return false;
            if (widthPx < 2 || heightPx < 2) return false;

            BoundingBoxXYZ? union = null;
            foreach (var id in focusIds)
            {
                try
                {
                    var el = doc.GetElement(RevitBridge.Common.ElementIdCompat.Create(id));
                    if (el == null) continue;
                    var bb = el.get_BoundingBox(sheet);
                    if (bb == null) continue;
                    if (union == null)
                    {
                        union = bb;
                    }
                    else
                    {
                        union.Min = new XYZ(Math.Min(union.Min.X, bb.Min.X), Math.Min(union.Min.Y, bb.Min.Y), Math.Min(union.Min.Z, bb.Min.Z));
                        union.Max = new XYZ(Math.Max(union.Max.X, bb.Max.X), Math.Max(union.Max.Y, bb.Max.Y), Math.Max(union.Max.Z, bb.Max.Z));
                    }
                }
                catch
                {
                    // ignore
                }
            }
            if (union == null) return false;

            BoundingBoxUV? outline = null;
            try { outline = sheet.Outline; } catch { outline = null; }
            if (outline == null) return false;

            var minU = outline.Min.U;
            var maxU = outline.Max.U;
            var minV = outline.Min.V;
            var maxV = outline.Max.V;
            var sheetW = maxU - minU;
            var sheetH = maxV - minV;
            if (sheetW <= 1e-6 || sheetH <= 1e-6) return false;

            // SelectionUtil.ExportViewImage uses FitToPage + Horizontal fit, so width should map directly to sheet width.
            var scale = widthPx / sheetW;
            var expectedH = sheetH * scale;
            var padY = Math.Max(0.0, (heightPx - expectedH) * 0.5);

            var min = new XYZ(union.Min.X - marginFt, union.Min.Y - marginFt, union.Min.Z);
            var max = new XYZ(union.Max.X + marginFt, union.Max.Y + marginFt, union.Max.Z);

            int Clamp(int v, int lo, int hi) => Math.Max(lo, Math.Min(hi, v));

            var left = (int)Math.Floor((min.X - minU) * scale);
            var right = (int)Math.Ceiling((max.X - minU) * scale);
            var top = (int)Math.Floor(padY + (maxV - max.Y) * scale);
            var bottom = (int)Math.Ceiling(padY + (maxV - min.Y) * scale);

            left = Clamp(left, 0, Math.Max(0, widthPx - 1));
            right = Clamp(right, 0, Math.Max(0, widthPx));
            top = Clamp(top, 0, Math.Max(0, heightPx - 1));
            bottom = Clamp(bottom, 0, Math.Max(0, heightPx));

            var w = Math.Max(0, right - left);
            var h = Math.Max(0, bottom - top);
            if (w < 80 || h < 60) return false;

            var dir = Path.GetDirectoryName(fullSheetPath) ?? "";
            var stem = Path.GetFileNameWithoutExtension(fullSheetPath) ?? "sheet";
            croppedPath = Path.Combine(dir, stem + "_titleblock_crop.png");

            using (var src = new Bitmap(fullSheetPath))
            using (var dst = new Bitmap(w, h))
            using (var g = Graphics.FromImage(dst))
            {
                g.DrawImage(src, new System.Drawing.Rectangle(0, 0, w, h), new System.Drawing.Rectangle(left, top, w, h), GraphicsUnit.Pixel);
                dst.Save(croppedPath, ImageFormat.Png);
            }

            croppedWidthPx = w;
            croppedHeightPx = h;
            warning = "capture-sheet-region cropped full-sheet export down to titleblock bounds (mapping unavailable for sheets).";
            return true;
        }

        private static async Task<object> OcrCapabilitiesViaBackend(int timeoutMs)
        {
            var portRaw = System.Environment.GetEnvironmentVariable("OPERATOR_BACKEND_PORT");
            var port = 7007;
            if (!string.IsNullOrWhiteSpace(portRaw) && int.TryParse(portRaw.Trim(), out var parsed) && parsed > 0) port = parsed;
            var baseUri = new System.Uri($"http://127.0.0.1:{port}/");

            using var http = new HttpClient { BaseAddress = baseUri, Timeout = System.TimeSpan.FromMilliseconds(System.Math.Max(300, System.Math.Min(5000, timeoutMs))) };
            var token = OperatorSecurity.GetOrCreateOperatorToken();
            http.DefaultRequestHeaders.TryAddWithoutValidation("X-Operator-Token", token);

            using var resp = await http.GetAsync("tools/ocr/capabilities").ConfigureAwait(false);
            var json = await resp.Content.ReadAsStringAsync().ConfigureAwait(false);
            if (!resp.IsSuccessStatusCode)
            {
                return new { ok = false, status = (int)resp.StatusCode, error = json };
            }

            try
            {
                using var doc = JsonDocument.Parse(json);
                return JsonSerializer.Deserialize<object>(doc.RootElement.GetRawText()) ?? (object)new { ok = false, error = "OCR capabilities response parse failed." };
            }
            catch
            {
                return new { ok = false, error = "OCR capabilities response was not valid JSON." };
            }
        }

        private static async Task<object> OcrViaBackend(string imagePath, string? kind, string? expected, int timeoutMs)
        {
            // Call the local Operator backend (same machine) so OCR dependencies can live outside Revit.
            var portRaw = System.Environment.GetEnvironmentVariable("OPERATOR_BACKEND_PORT");
            var port = 7007;
            if (!string.IsNullOrWhiteSpace(portRaw) && int.TryParse(portRaw.Trim(), out var parsed) && parsed > 0) port = parsed;
            var baseUri = new System.Uri($"http://127.0.0.1:{port}/");

            using var http = new HttpClient { BaseAddress = baseUri, Timeout = System.TimeSpan.FromMilliseconds(System.Math.Max(500, timeoutMs)) };
            var token = OperatorSecurity.GetOrCreateOperatorToken();
            http.DefaultRequestHeaders.TryAddWithoutValidation("X-Operator-Token", token);

            var payload = new
            {
                image_path = imagePath,
                kind = (kind ?? "date").Trim().ToLowerInvariant(),
                expected = expected,
                timeout_ms = timeoutMs
            };
            var body = JsonSerializer.Serialize(payload);
            using var req = new HttpRequestMessage(HttpMethod.Post, "tools/ocr")
            {
                Content = new StringContent(body, Encoding.UTF8, "application/json")
            };

            using var resp = await http.SendAsync(req).ConfigureAwait(false);
            var json = await resp.Content.ReadAsStringAsync().ConfigureAwait(false);
            if (!resp.IsSuccessStatusCode)
            {
                return new { ok = false, status = (int)resp.StatusCode, error = json };
            }

            try
            {
                using var doc = JsonDocument.Parse(json);
                return JsonSerializer.Deserialize<object>(doc.RootElement.GetRawText()) ?? (object)new { ok = false, error = "OCR response parse failed." };
            }
            catch
            {
                return new { ok = false, error = "OCR response was not valid JSON." };
            }
        }
    }
}
