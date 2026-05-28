using System;
using System.Text.Json.Serialization;
using Autodesk.Revit.DB;

namespace RevitBridge.Logic.Handlers.Drafting
{
    public sealed class DraftPoint
    {
        // One of:
        // - xyz: model coordinates in feet
        // - xPx/yPx: pixel coordinates (requires request.frameId)
        // - xIn/yIn: inches in view plane (z assumed 0)

        [JsonPropertyName("xyz")]
        public double[]? xyz { get; set; }

        [JsonPropertyName("xPx")]
        public int? xPx { get; set; }

        [JsonPropertyName("yPx")]
        public int? yPx { get; set; }

        [JsonPropertyName("xIn")]
        public double? xIn { get; set; }

        [JsonPropertyName("yIn")]
        public double? yIn { get; set; }

        public XYZ Resolve(string? frameId)
        {
            if (xyz != null && xyz.Length >= 2)
            {
                var x = xyz[0];
                var y = xyz[1];
                var z = xyz.Length >= 3 ? xyz[2] : 0.0;
                return new XYZ(x, y, z);
            }

            if (xIn.HasValue && yIn.HasValue)
            {
                return new XYZ(xIn.Value / 12.0, yIn.Value / 12.0, 0);
            }

            if (xPx.HasValue && yPx.HasValue)
            {
                if (string.IsNullOrWhiteSpace(frameId)) throw new InvalidOperationException("Point uses xPx/yPx but request.frameId is missing.");
                if (!FrameStore.TryGet(frameId.Trim(), out var frame) || frame == null)
                    throw new InvalidOperationException($"Frame not found (expired?): {frameId}");

                return SelectionUtil.PixelToModel(
                    xPx.Value,
                    yPx.Value,
                    frame.widthPx,
                    frame.heightPx,
                    frame.topLeft,
                    frame.topRight,
                    frame.bottomLeft);
            }

            throw new InvalidOperationException("Point must provide xyz, xPx/yPx, or xIn/yIn.");
        }
    }
}

