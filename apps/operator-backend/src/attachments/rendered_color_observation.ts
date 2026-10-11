/** Pixel observation only: never promotes a PDF, model, or task to verified. */
export function observeRenderedColor(rgba: Uint8ClampedArray, width: number, height: number) {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || rgba.length !== width * height * 4) {
    throw new Error("Rendered color observation requires exact RGBA dimensions.");
  }
  let chromatic = 0, maxDifference = 0;
  for (let i = 0; i < rgba.length; i += 4) {
    // Match the visible page on white, including transparent source content.
    const alpha = rgba[i + 3]! / 255;
    const r = Math.round(255 + alpha * (rgba[i]! - 255));
    const g = Math.round(255 + alpha * (rgba[i + 1]! - 255));
    const b = Math.round(255 + alpha * (rgba[i + 2]! - 255));
    const difference = Math.max(r, g, b) - Math.min(r, g, b);
    maxDifference = Math.max(maxDifference, difference);
    if (difference > 3) chromatic++;
  }
  return {
    schema: "operator.rendered-color-observation.v1",
    width_px: width, height_px: height, pixel_count: width * height,
    chromatic_pixel_count: chromatic, channel_difference_threshold: 3,
    maximum_channel_difference: maxDifference,
    observation: chromatic ? "color_detected" : "no_color_detected_at_render_resolution",
    limitation: "Only the returned raster region at its stated resolution. No claim about unrendered pages, finer details, semantic completeness, or binary black-and-white output. Review the image too."
  };
}
