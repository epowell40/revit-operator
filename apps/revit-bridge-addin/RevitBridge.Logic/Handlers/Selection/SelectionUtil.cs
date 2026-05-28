using System;
using System.Collections.Generic;
using System.Drawing;
using System.IO;
using Autodesk.Revit.DB;
using RevitBridge.Common;

namespace RevitBridge.Logic.Handlers
{
    internal sealed class RasterAffineFrame
    {
        public XYZ CropTopLeft { get; set; } = XYZ.Zero;
        public XYZ CropTopRight { get; set; } = XYZ.Zero;
        public XYZ CropBottomLeft { get; set; } = XYZ.Zero;
        public XYZ TopLeft { get; set; } = XYZ.Zero;
        public XYZ TopRight { get; set; } = XYZ.Zero;
        public XYZ BottomLeft { get; set; } = XYZ.Zero;
        public int WidthPx { get; set; }
        public int HeightPx { get; set; }
        public double CropAspect { get; set; }
        public double FrameAspect { get; set; }
        public double RasterAspect { get; set; }
        public double AspectMismatch { get; set; }
        public bool AspectCorrectionApplied { get; set; }
        public string AspectCorrectionAxis { get; set; } = "";
    }

    internal static class SelectionUtil
    {
        public static bool IsSupported2dView(View view)
        {
            // Selection mapping relies on View.CropBox. Many view types (sheets, schedules, etc.)
            // do not support crop boxes or deterministic 2D mapping.
            if (view == null) return false;
            if (view.ViewType == ViewType.ThreeD) return false;
            if (view.ViewType == ViewType.DrawingSheet) return false;
            if (view.ViewType == ViewType.Schedule) return false;
            if (view.ViewType == ViewType.Legend) return false;
            if (view is ViewSheet) return false;
            if (view is ViewSchedule) return false;

            try
            {
                var _ = view.CropBox;
            }
            catch
            {
                return false;
            }

            return true;
        }

        public static (XYZ topLeft, XYZ topRight, XYZ bottomLeft) GetCropCorners(View view)
        {
            if (!view.CropBoxActive)
                throw new ArgumentException("Phase 1 requires an active crop box (CropBoxActive == true) for deterministic pixel-to-model mapping.");

            var crop = view.CropBox;
            var min = crop.Min;
            var max = crop.Max;
            var z = (min.Z + max.Z) / 2.0;

            var t = crop.Transform;
            var topLeft = t.OfPoint(new XYZ(min.X, max.Y, z));
            var topRight = t.OfPoint(new XYZ(max.X, max.Y, z));
            var bottomLeft = t.OfPoint(new XYZ(min.X, min.Y, z));

            return (topLeft, topRight, bottomLeft);
        }

        public static XYZ PixelToModel(int xPx, int yPx, int widthPx, int heightPx, XYZ topLeft, XYZ topRight, XYZ bottomLeft)
        {
            if (widthPx <= 1 || heightPx <= 1)
                throw new ArgumentException("Invalid image size; widthPx/heightPx must be > 1.");

            var u = Math.Max(0.0, Math.Min(1.0, xPx / (double)(widthPx - 1)));
            var v = Math.Max(0.0, Math.Min(1.0, yPx / (double)(heightPx - 1)));
            return topLeft + u * (topRight - topLeft) + v * (bottomLeft - topLeft);
        }

        public static RasterAffineFrame BuildRasterAffineFrame(View view, int widthPx, int heightPx)
        {
            var (cropTopLeft, cropTopRight, cropBottomLeft) = GetCropCorners(view);
            return BuildRasterAffineFrame(cropTopLeft, cropTopRight, cropBottomLeft, widthPx, heightPx);
        }

        public static RasterAffineFrame BuildRasterAffineFrame(
            XYZ cropTopLeft,
            XYZ cropTopRight,
            XYZ cropBottomLeft,
            int widthPx,
            int heightPx)
        {
            var cropXAxis = cropTopRight - cropTopLeft;
            var cropYAxis = cropBottomLeft - cropTopLeft;
            var cropWidth = cropXAxis.GetLength();
            var cropHeight = cropYAxis.GetLength();
            var cropAspect = cropHeight > 1e-9 ? cropWidth / cropHeight : 0.0;
            var rasterAspect = Math.Max(1.0, widthPx - 1.0) / Math.Max(1.0, heightPx - 1.0);

            var frame = new RasterAffineFrame
            {
                CropTopLeft = cropTopLeft,
                CropTopRight = cropTopRight,
                CropBottomLeft = cropBottomLeft,
                TopLeft = cropTopLeft,
                TopRight = cropTopRight,
                BottomLeft = cropBottomLeft,
                WidthPx = widthPx,
                HeightPx = heightPx,
                CropAspect = cropAspect,
                FrameAspect = cropAspect,
                RasterAspect = rasterAspect,
                AspectMismatch = Math.Abs(cropAspect - rasterAspect),
                AspectCorrectionApplied = false,
                AspectCorrectionAxis = ""
            };

            if (!IsFinite(cropWidth) || !IsFinite(cropHeight) || !IsFinite(rasterAspect)) return frame;
            if (cropWidth < 1e-9 || cropHeight < 1e-9) return frame;

            var correctedWidth = cropHeight * rasterAspect;
            if (!IsFinite(correctedWidth) || correctedWidth < 1e-9) return frame;

            var deltaWidth = correctedWidth - cropWidth;
            if (Math.Abs(deltaWidth) < 1e-6) return frame;

            var xDirection = cropXAxis.Normalize();
            var xOffset = xDirection.Multiply(deltaWidth * 0.5);

            frame.TopLeft = cropTopLeft - xOffset;
            frame.TopRight = cropTopRight + xOffset;
            frame.BottomLeft = cropBottomLeft - xOffset;
            frame.FrameAspect = correctedWidth / cropHeight;
            frame.AspectMismatch = Math.Abs(frame.FrameAspect - rasterAspect);
            frame.AspectCorrectionApplied = true;
            frame.AspectCorrectionAxis = "x";

            return frame;
        }

        public static object BuildRasterAffineMappingPayload(
            RasterAffineFrame frame,
            string notes)
        {
            return new
            {
                mode = "2d_affine",
                topLeftXyz = new[] { frame.TopLeft.X, frame.TopLeft.Y, frame.TopLeft.Z },
                topRightXyz = new[] { frame.TopRight.X, frame.TopRight.Y, frame.TopRight.Z },
                bottomLeftXyz = new[] { frame.BottomLeft.X, frame.BottomLeft.Y, frame.BottomLeft.Z },
                pixelAxes = new { x = "right", y = "down" },
                modelUnits = "feet",
                frameBasis = "exported_raster",
                rasterWidthPx = frame.WidthPx,
                rasterHeightPx = frame.HeightPx,
                rasterAspect = frame.RasterAspect,
                frameAspect = frame.FrameAspect,
                cropBoxAspect = frame.CropAspect,
                aspectMismatch = frame.AspectMismatch,
                aspectCorrectionApplied = frame.AspectCorrectionApplied,
                aspectCorrectionAxis = string.IsNullOrWhiteSpace(frame.AspectCorrectionAxis) ? null : frame.AspectCorrectionAxis,
                cropBoxReference = new
                {
                    topLeftXyz = new[] { frame.CropTopLeft.X, frame.CropTopLeft.Y, frame.CropTopLeft.Z },
                    topRightXyz = new[] { frame.CropTopRight.X, frame.CropTopRight.Y, frame.CropTopRight.Z },
                    bottomLeftXyz = new[] { frame.CropBottomLeft.X, frame.CropBottomLeft.Y, frame.CropBottomLeft.Z }
                },
                notes
            };
        }

        public static (int widthPx, int heightPx) ReadImageSize(string path)
        {
            using (var img = Image.FromFile(path))
            {
                return (img.Width, img.Height);
            }
        }

        public static string EnsureDefaultSelectionCaptureFolder(string? folder)
        {
            return WorkspacePaths.ResolveDirectoryUnderWorkspace(folder, "artifacts", "captures", "selection");
        }

        public static string ExportViewImage(Document doc, View view, int imageSize, string folder, string fileStem)
        {
            var filePathNoExt = Path.Combine(folder, fileStem);

            var options = new ImageExportOptions
            {
                ZoomType = ZoomFitType.FitToPage,
                PixelSize = imageSize,
                FilePath = filePathNoExt,
                FitDirection = FitDirectionType.Horizontal,
                ExportRange = ExportRange.SetOfViews
            };
            options.SetViewsAndSheets(new List<ElementId> { view.Id });

            doc.ExportImage(options);

            var png = filePathNoExt + ".png";
            if (File.Exists(png)) return png;
            var jpg = filePathNoExt + ".jpg";
            if (File.Exists(jpg)) return jpg;

            // Revit sometimes appends view name / view type in the filename. Search by prefix.
            try
            {
                var di = new DirectoryInfo(folder);
                if (di.Exists)
                {
                    FileInfo? best = null;
                    foreach (var fi in di.GetFiles(fileStem + "*"))
                    {
                        var ext = fi.Extension?.ToLowerInvariant() ?? "";
                        if (ext != ".png" && ext != ".jpg" && ext != ".jpeg" && ext != ".tif" && ext != ".tiff" && ext != ".bmp")
                            continue;

                        if (best == null || fi.LastWriteTimeUtc > best.LastWriteTimeUtc)
                            best = fi;
                    }
                    if (best != null)
                        return best.FullName;
                }
            }
            catch
            {
                // Ignore and throw a clearer error below.
            }

            throw new FileNotFoundException($"ExportImage did not produce an output file for stem '{fileStem}' in folder '{folder}'.");
        }

        public static bool TryParseBuiltInCategories(IEnumerable<string>? categories, out List<BuiltInCategory> parsed, out List<string> invalid)
        {
            parsed = new List<BuiltInCategory>();
            invalid = new List<string>();
            if (categories == null) return true;

            foreach (var c in categories)
            {
                if (string.IsNullOrWhiteSpace(c)) continue;
                if (BuiltInCategoryTokenUtil.TryParse(c.Trim(), out var bic))
                    parsed.Add(bic);
                else
                    invalid.Add(c);
            }
            return invalid.Count == 0;
        }

        public static bool MatchesCategoryFilter(Element e, IEnumerable<string>? filters)
        {
            if (e == null || filters == null) return false;

            var builtIn = e.Category?.BuiltInCategory.ToString() ?? "";
            var categoryName = e.Category?.Name ?? "";
            var token = GetCategoryToken(e) ?? "";
            var categoryId = e.Category != null ? ElementIdCompat.GetValue(e.Category.Id) : 0;

            foreach (var raw in filters)
            {
                if (string.IsNullOrWhiteSpace(raw)) continue;
                var filter = raw.Trim();
                if (filter.Length == 0) continue;

                if (string.Equals(filter, builtIn, StringComparison.OrdinalIgnoreCase)) return true;
                if (string.Equals(filter, categoryName, StringComparison.OrdinalIgnoreCase)) return true;
                if (string.Equals(filter, token, StringComparison.OrdinalIgnoreCase)) return true;
                if (BuiltInCategoryTokenUtil.TryParse(filter, out var bic) && categoryId == (long)bic) return true;
            }

            return false;
        }

        public static string? GetCategoryToken(Element e)
        {
            var cat = e.Category;
            if (cat == null) return null;
            var id = RevitBridge.Common.ElementIdCompat.GetValue(cat.Id);
            if (Enum.IsDefined(typeof(BuiltInCategory), id))
                return ((BuiltInCategory)id).ToString();
            return cat.Name;
        }

        private static bool IsFinite(double value) => !double.IsNaN(value) && !double.IsInfinity(value);
    }
}
